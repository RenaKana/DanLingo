import { attachUiMessages } from '../src/i18n/wire.ts';
import { BUILD_ID } from '../src/core/build-identity';
import { parseUserFilterSummary } from '../src/platforms/bilibili/user-filter-wire';
import { auditCache, auditCacheState, auditUrl } from '../src/diagnostics/bilibili-audit-cache';
import type { LocalExperiment, LocalExperimentBudget } from '../src/diagnostics/bilibili-local-experiment';
import { LivePreviewHost, NATIVE_SUPPLY_GUARD_KEY, OWNED_SUPPLY_GUARD_KEY,
  OWNED_SUPPLY_GRANT_KEY } from '../src/diagnostics/live-preview-host';
import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { DEFAULT_SETTINGS, SETTINGS_KEY, KEY_STORAGE_KEY, endpointOrigin, normalizeSettings, providerTimeoutMs, strategySettings } from '../src/core/config';
import { resourceFromUrl, sameResource, sameSession, validSession, cacheResource, localDeadline, clockStamp, matchesResourceUrl, resourceOrigin } from '../src/core/resource';
import { bilibiliSourceEventId } from '../src/core/messages';
import { nativeMetrics } from '../src/core/live-metrics';
import { videoBatchLimit } from '../src/core/video-policy';
import { getTimeoutRetryPolicy } from '../src/core/timeout-retry';
import { prepareEmoteText } from '../src/platforms/bilibili-live/emotes';
import { adapterDiagnostic, diagnosticCandidate, parseAdapterDiagnostic } from '../src/core/adapter-diagnostic';
import { TranslationEngine, IndexedDbTranslationCache } from '../src/translation';
import { discoverModels, ProviderError } from '../src/translation/provider';
import { ModelTestError, testModel } from '../src/translation/model-test';
import { PerformanceTest, validatePerformanceConfig } from '../src/translation/performance-test';
import { PerformanceHistory } from '../src/translation/performance-history';
import { hybridCapacityIdentity, recommendHybridCapacity } from '../src/translation/hybrid-capacity';
import { addUsage, ChatCompletionsProvider, setProviderTransportGuard } from '../src/translation/provider';
import { createLocalFetch, localControl } from '../src/local/bridge';
import { normalizeLocalConfig } from '../src/local/config';
import { LOCAL_CHANNEL } from '../src/local/types';
import { withLocalRuntime } from '../src/local/provider-settings';
import { translationLanguageIssue, translationLanguageMessage } from '../src/local/translation-profile';
import { LocalAutoLoader } from '../src/local/auto-load';
import type { LocalRuntimeStatus } from '../src/local/auto-load';
import { ModelCatalogStore, MODEL_CATALOG_KEY, modelCatalogScope, selectModelEffort } from '../src/core/model-catalog';
import { ServiceHistory } from '../src/core/service-history';
import { OnlineRequestBudget, OnlineBudgetError } from '../src/core/online-budget';
import { getTranslationShortcut, registerTranslationShortcutHandler } from '../src/core/translation-shortcut';
import { SettingsFrameGrants, settingsFrameToken, settingsHostOrigin } from '../src/core/settings-frame';
import { discoverConnectionModels } from '../src/translation/connection-discovery';
import type { ProviderSettings } from '../src/core/types';
import type { AdapterDiagnostic, RuntimeStatus, Settings, TranslationInput, TranslationOutput, TranslationRequest, ResourceSession } from '../src/core/types';

interface Sender { id?: string; url?: string; frameId?: number; documentId?: string; tab?: { id?: number; url?: string } }
interface TabState { status?: RuntimeStatus; lastSeen: number; session?: ResourceSession; documentId?: string }

export default defineBackground(() => {
  const userFilterGuardKey = 'bilibiliUserFilters.zeroTransport.v1';
  const renderPreviewGuardKey = 'bilibiliRenderPreview.zeroTransport.v1';
  let userFilterBlockedTransports = 0;
  let userFilterGuardMutation = false;
  function guardFields(value: unknown): { enabled?: boolean; kind?: string; tabId?: number; startedAt?: number } | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }
  setProviderTransportGuard(async context => {
    // Read on every real transmission: the task-owned local flag survives worker restarts
    // and extension reloads; a read failure must not bypass the zero budget.
    const stored = await browser.storage.local.get([userFilterGuardKey, renderPreviewGuardKey,
      NATIVE_SUPPLY_GUARD_KEY, OWNED_SUPPLY_GUARD_KEY]);
    if (context.localPreviewPermit && await ownedSupplyHost.acceptsTransport(context)) return;
    if (context.localPreviewPermit && await nativeSupplyHost.acceptsTransport(context)) return;
    if (context.localPreviewPermit && await livePreviewHost.acceptsTransport(context)) return;
    if (context.localPreviewPermit) throw new ProviderError('local-preview-permit-revoked');
    if (stored[userFilterGuardKey] || guardFields(stored[renderPreviewGuardKey])?.enabled === true ||
        guardFields(stored[NATIVE_SUPPLY_GUARD_KEY])?.enabled === true ||
        guardFields(stored[OWNED_SUPPLY_GUARD_KEY])?.enabled === true) {
      userFilterBlockedTransports++; throw new ProviderError('user-filters-zero-model-budget');
    }
  });
  async function renderPreviewProtections() {
    const stored = await browser.storage.local.get([userFilterGuardKey, renderPreviewGuardKey, OWNED_SUPPLY_GUARD_KEY]);
    const persistent = stored[userFilterGuardKey], fields = guardFields(persistent), temporary = guardFields(stored[renderPreviewGuardKey]);
    const owned = guardFields(stored[OWNED_SUPPLY_GUARD_KEY]);
    return {
      persistentGuard: { key: userFilterGuardKey, present: persistent !== undefined,
        enabled: !!persistent, declaredEnabled: typeof fields?.enabled === 'boolean' ? fields.enabled : null,
        kind: typeof fields?.kind === 'string' ? fields.kind : null,
        ownerTabId: Number.isSafeInteger(fields?.tabId) ? fields!.tabId : null },
      temporaryGuard: { key: renderPreviewGuardKey, enabled: temporary?.enabled === true,
        kind: typeof temporary?.kind === 'string' ? temporary.kind : null,
        ownerTabId: Number.isSafeInteger(temporary?.tabId) ? temporary!.tabId : null },
      ownedGuard: { key: OWNED_SUPPLY_GUARD_KEY, enabled: owned?.enabled === true,
        kind: typeof owned?.kind === 'string' ? owned.kind : null,
        ownerTabId: Number.isSafeInteger(owned?.tabId) ? owned!.tabId : null },
      effectiveZeroTransport: !!persistent || temporary?.enabled === true || owned?.enabled === true,
    };
  }
  const auditWorkerSession = crypto.randomUUID();
  const cache = new IndexedDbTranslationCache();
  const keepAlive = () => {
    // Finite long-running operation guard, not a persistent background heartbeat.
    // https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers#keep_a_service_worker_alive
    const timer = setInterval(() => { void browser.runtime.getPlatformInfo().catch(() => {}); }, 20_000);
    return () => clearInterval(timer);
  };
  const onlineBudget = new OnlineRequestBudget();
  const livePreviewHost: LivePreviewHost = new LivePreviewHost({ buildId: BUILD_ID, storage: browser.storage.local,
    localControl, createLocalFetch, keepAlive,
    globalIdle: async () => {
      const { settings } = await config();
      return !settings.enabled && !nativeSupplyHost.active && !ownedSupplyHost.active && ordinaryExperimentIdle() && experimentRuns.size === 0 && experimentStarting.size === 0;
    },
    context: async tabId => {
      const tab = tabs.get(tabId), current = await currentResource(tabId);
      if (!tab?.documentId || !validSession(tab.session) || !current ||
          !sameResource(tab.session, current) || tab.session.platform !== 'bilibili' || tab.session.scenario !== 'video') return null;
      const { settings } = await config();
      return { settings, configVersion: version, tabId, documentId: tab.documentId, session: tab.session,
        idle: !nativeSupplyHost.active && !ownedSupplyHost.active && ordinaryExperimentIdle() && experimentRuns.size === 0 && experimentStarting.size === 0 };
    },
    page: (tabId, documentId, message) => browser.tabs.sendMessage(tabId, message, { documentId, frameId: 0 }),
  });
  const nativeSupplyHost: LivePreviewHost = new LivePreviewHost({ purpose: 'native-supply', buildId: BUILD_ID, storage: browser.storage.local,
    localControl, createLocalFetch, keepAlive,
    globalIdle: async () => {
      const { settings } = await config();
      return !settings.enabled && !livePreviewHost.active && !ownedSupplyHost.active && ordinaryExperimentIdle() && experimentRuns.size === 0 && experimentStarting.size === 0;
    },
    context: async tabId => {
      const tab = tabs.get(tabId), current = await currentResource(tabId);
      if (!tab?.documentId || !validSession(tab.session) || !current ||
          !sameResource(tab.session, current) || tab.session.platform !== 'bilibili' || tab.session.scenario !== 'video') return null;
      const { settings } = await config();
      return { settings, configVersion: version, tabId, documentId: tab.documentId, session: tab.session,
        idle: !livePreviewHost.active && !ownedSupplyHost.active && ordinaryExperimentIdle() && experimentRuns.size === 0 && experimentStarting.size === 0 };
    },
    page: (tabId, documentId, message) => browser.tabs.sendMessage(tabId, message, { documentId, frameId: 0 }),
  });
  const ownedSupplyHost: LivePreviewHost = new LivePreviewHost({ purpose: 'owned-supply', buildId: BUILD_ID,
    storage: browser.storage.local, localControl, createLocalFetch, keepAlive,
    globalIdle: async () => {
      const { settings } = await config();
      return !settings.enabled && !livePreviewHost.active && !nativeSupplyHost.active &&
        ordinaryExperimentIdle() && experimentRuns.size === 0 && experimentStarting.size === 0;
    },
    context: async tabId => {
      const tab = tabs.get(tabId), current = await currentResource(tabId);
      if (!tab?.documentId || !validSession(tab.session) || !current ||
          !sameResource(tab.session, current) || tab.session.platform !== 'bilibili' ||
          tab.session.scenario !== 'video') return null;
      const { settings } = await config();
      return { settings, configVersion: version, tabId, documentId: tab.documentId, session: tab.session,
        idle: !livePreviewHost.active && !nativeSupplyHost.active && ordinaryExperimentIdle() &&
          experimentRuns.size === 0 && experimentStarting.size === 0 };
    },
    page: (tabId, documentId, message) => browser.tabs.sendMessage(tabId, message, { documentId, frameId: 0 }),
  });
  const providerOptions = (settings: ProviderSettings) => ({ keepAlive, ...(settings.backend === 'local' ? { fetch: createLocalFetch(settings.localModelId ?? '') } : {
    beforeOnlineRequest: async (signal: AbortSignal) => {
      try {
        // Tests may use unsaved connection settings; the shared cap always uses saved settings.
        const latest = await config();
        await onlineBudget.reserve(latest.settings.onlineRequestLimitPerDay, signal);
      } catch (error) {
        throw new ProviderError(error instanceof OnlineBudgetError ? error.code : 'online-budget-storage-unavailable');
      }
    },
  }) });
  const engine = new TranslationEngine({ cache, maxRequestItems: 200, keepAlive,
    provider: { complete: async request => {
      const result = await new ChatCompletionsProvider(providerOptions(request.settings)).complete({ ...request,
        apiKey: request.settings.backend === 'local' ? 'local-inference' : request.apiKey });
      if ([...result.items.values()].some(item => item.text && !item.reason)) rememberWorkingService(request.settings);
      return result;
    } } });
  const tabs = new Map<number, TabState>();
  // Diagnostic reads must not allocate a TabState or keep a translation session alive.
  const navigationEpochs = new Map<number, number>();
  const running = new Map<string, AbortController>();
  const revokedVideoItems = new WeakMap<AbortController, Set<string>>();
  const liveRunning = new Set<string>();
  type ExperimentRange = { fromMs: number; toMs: number; prefetchSeconds: number };
  type ExperimentItem = { id: string; text: string; mediaTimeMs: number; translationEligible: boolean };
  type ExperimentPreview = { range: ExperimentRange; resourceId: string; session: ResourceSession;
    documentId: string; configVersion: number; watchVersion: string; watchBuildId: string; eligible: Map<string, string>; at: number };
  type ExperimentDispatch = { backgroundVersion: string; watchVersion: string; backgroundBuildId: string; watchBuildId: string; savedBatchLimit: number;
    effectiveBatchLimit: number; concurrency: number; comparison: boolean; singleDispatch: boolean;
    checkedPackets: number; admittedPackets: number; rawPacketSizes: Record<string, number>;
    peakRequests: number; violationReason: string | null };
  type ExperimentRun = { tabId: number; runId: string; resourceId: string; session: ResourceSession;
    documentId: string; configVersion: number; experiment: LocalExperiment; eligible: Map<string, string>; requestTimeoutMs: number;
    requests: Map<string, AbortController>; requestIds: Set<string>; dispatch: ExperimentDispatch;
    watchEvents: Record<string, unknown>[]; watchEventsTruncated: boolean };
  const experimentPreviews = new Map<number, ExperimentPreview>();
  const experimentRuns = new Map<number, ExperimentRun>();
  const experimentReports = new Map<number, ExperimentRun>();
  const experimentStarting = new Map<number, { runId: string; cancelled: boolean; expected?: ResourceSession }>();
  let version = 0;
  let credentialRejected = false;
  let modelLookup: AbortController | undefined;
  let modelTest: AbortController | undefined;
  let performanceTest: PerformanceTest | undefined;
  const performanceHistory = new PerformanceHistory(browser.storage.local);
  let performanceSaveState: 'pending' | 'saved' | 'failed' | 'deleted' | null = null;
  type BatchPhase = 'preparing' | 'unloading' | 'loading' | 'testing' | 'saving' | 'finishing' | 'done';
  type PerformanceBatch = { id: string; modelIds: string[]; index: number; total: number; completed: number;
    phase: BatchPhase; state: 'running' | 'completed' | 'stopped' | 'failed';
    errorCode?: string; modelId?: string; modelName?: string; cancelled: boolean; cancelReason?: string };
  let performanceBatch: PerformanceBatch | undefined;
  // A deleted report must never be reintroduced by a late auto-save or a manual retry.
  const deletedPerformanceIds = new Set<string>();
  const batchReportIds = new Set<string>();
  function rememberDeleted(id: string) {
    deletedPerformanceIds.delete(id); deletedPerformanceIds.add(id);
    if (deletedPerformanceIds.size > 200) deletedPerformanceIds.delete(deletedPerformanceIds.values().next().value!);
  }
  const batchStatus = () => performanceBatch ? (() => {
    const { cancelled, cancelReason, ...publicStatus } = performanceBatch;
    return { ...publicStatus, modelIds: [...publicStatus.modelIds] };
  })() : null;
  async function savePerformance(run: PerformanceTest) {
    if (run.report.state === 'running') return;
    if (deletedPerformanceIds.has(run.report.id)) { performanceSaveState = 'deleted'; return performanceSaveState; }
    performanceSaveState = 'pending';
    try { await performanceHistory.save(run.snapshot()); performanceSaveState = deletedPerformanceIds.has(run.report.id) ? 'deleted' : 'saved'; }
    catch { performanceSaveState = deletedPerformanceIds.has(run.report.id) ? 'deleted' : 'failed'; }
    return performanceSaveState;
  }
  let localPerformanceBaseline: { id: string; generation: number; calls: number } | undefined;
  const TEST_PAUSE_KEY = 'performancePause.v1';
  type TestLease = { id: string; kind: 'performance' | 'local-benchmark'; benchmarkId?: string; cancelled: boolean; release: () => void; releasing?: Promise<void> };
  let testPause: TestLease | undefined;
  let localChoiceLoading = false;
  function configuredOrigin(settings: Pick<ProviderSettings, 'endpoint' | 'allowLocalHttp'>): string | undefined {
    return settings.endpoint.trim() ? endpointOrigin(settings.endpoint, settings.allowLocalHttp) : undefined;
  }
  function onlineSetupError(settings: Pick<ProviderSettings, 'endpoint' | 'model'>): string | undefined {
    if (!settings.endpoint.trim()) return '请先填写服务地址';
    if (!settings.model.trim()) return '请先选择或填写模型';
    return undefined;
  }
  async function readyLocal(settings: ProviderSettings, waitForLoad = true) {
    if (localChoiceLoading) throw new ProviderError('LOCAL_MODEL_LOADING');
    try { return await localLoader.ready(settings, waitForLoad); }
    catch (error) { throw new ProviderError(error instanceof Error ? error.message : 'LOCAL_LOAD_FAILED'); }
  }
  const hybridEnabled = (settings: Settings) => settings.bilibiliOwnedRelease === true && settings.bilibiliHybrid?.enabled === true;
  async function hybridRoute(settings: Settings, apiKey: string, capturedVersion: number): Promise<NonNullable<TranslationRequest['hybrid']> | { error: string }> {
    const capacityKey = await hybridCapacityIdentity(settings);
    const capacity = settings.bilibiliHybrid?.profiles.find(profile => profile.identity === capacityKey);
    if (!capacity || !settings.localModelId) return { error: '请为当前本地模型和参数设置混合容量' };
    let local: Settings = { ...settings, backend: 'local', concurrency: settings.localConcurrency, batchSize: 1 };
    const online: Settings = { ...settings, backend: 'online', concurrency: settings.onlineConcurrency, batchSize: settings.videoBatchSize,
      translationStream: settings.bilibiliHybrid?.onlineStreaming === true };
    const state = !testPause && !localChoiceLoading ? await localLoader.peekReady(local).catch(() => undefined) : undefined;
    if (state) local = withLocalRuntime(local, state);
    else {
      // Registered metadata determines the local cache namespace even before the model is loaded.
      const listed = await localControl({ action: 'list' }).catch(() => null);
      const model = listed?.models?.find(item => item.id === settings.localModelId);
      if (model) local = { ...local, localModelName: model.name, localTranslationProfile: model.translationProfile };
    }
    const origin = configuredOrigin(online);
    const onlineReady = !onlineSetupError(online) && !!apiKey && !credentialRejected && !!origin &&
      await browser.permissions.contains({ origins: [origin + '/*'] }).catch(() => false);
    const localReady = !!state && await hybridCapacityIdentity(withLocalRuntime(settings, state)) === capacityKey &&
      !translationLanguageIssue(local.localTranslationProfile, local.sourceLanguage, local.targetLanguage);
    return { local, online, localReady, onlineReady, capacityKey, maxItems: capacity.maxItems,
      adaptive: settings.bilibiliHybrid?.adaptive === true, onlineStreaming: settings.bilibiliHybrid?.onlineStreaming === true,
      maxChars: capacity.maxChars, ...(capacity.p95Ms ? { p95Ms: capacity.p95Ms } : {}),
      onLocalNeeded: () => {
        if (!state && !testPause && !localChoiceLoading && capturedVersion === version)
          void readyLocal({ ...settings, backend: 'local' }, false).catch(() => {});
      } };
  }
  const ready = (async () => {
    await browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await browser.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const stored = await browser.storage.local.get(SETTINGS_KEY);
    if (!stored[SETTINGS_KEY]) await browser.storage.local.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, reasoningProfileOverride: 'auto' } });
  })();
  function localIdlePolicy(settings: Settings) {
    return { enabled: settings.localIdleUnloadEnabled, timeoutMs: settings.localIdleUnloadMinutes * 60_000 };
  }
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SETTINGS_KEY]) return;
    const policy = localIdlePolicy(normalizeSettings(changes[SETTINGS_KEY].newValue, { stored: true }));
    // A policy save must not create a model runtime just to update its idle timer.
    void browser.runtime.sendMessage({ channel: LOCAL_CHANNEL, action: 'idle-policy', policy }).catch(() => {});
  });
  const catalogs = new ModelCatalogStore(browser.storage.local);
  const serviceHistory = new ServiceHistory(browser.storage.local);
  const rememberedServices = new Set<string>();
  function rememberWorkingService(settings: ProviderSettings) {
    if (settings.backend === 'local') return;
    const identity = JSON.stringify([settings.endpoint, settings.endpointMode]);
    if (rememberedServices.has(identity)) return;
    // One background write per used address per worker; normal live throughput must not cause storage churn.
    if (rememberedServices.size >= 30) rememberedServices.clear();
    rememberedServices.add(identity);
    void serviceHistory.record(settings).catch(() => rememberedServices.delete(identity));
  }
  const frameGrants = new SettingsFrameGrants(browser.storage.session);
  const localLoader = new LocalAutoLoader({ storage: browser.storage.session, control: localControl, keepAlive,
    changed: status => { void broadcastLocal(status); } });
  async function broadcastLocal(localRuntime: LocalRuntimeStatus) {
    const message = { type: 'local-runtime-updated', localRuntime };
    await Promise.allSettled([...tabs.keys()].map(tabId => browser.tabs.sendMessage(tabId, message, { frameId: 0 })).concat(browser.runtime.sendMessage(message)));
  }
  async function prepareLocal(onEntry = false, stillCurrent = () => true) {
    if (testPause || localChoiceLoading) return;
    const { settings } = await config();
    const hybridVideo = hybridEnabled(settings) && [...tabs.values()].some(tab => tab.session?.platform === 'bilibili' && tab.session.scenario === 'video');
    if (!testPause && !localChoiceLoading && stillCurrent() && (!onEntry || settings.localPreloadOnEntry) && settings.enabled && settings.displayMode === 'translated' && (settings.backend === 'local' || hybridVideo) && settings.localModelId) {
      try { await localLoader.ready({ ...settings, backend: 'local' }); } catch { /* Loading/failure is published separately. */ }
    }
  }
  // MV3 worker restarts must not turn an unchanged heartbeat into a fresh page entry.
  const ENTRY_KEY = 'localPreloadEntries.v1';
  let entryWrites = Promise.resolve();
  function prepareEntry(tabId: number, visit?: string, stillCurrent = () => true) {
    entryWrites = entryWrites.catch(() => {}).then(async () => {
      if (!stillCurrent()) return;
      const stored = (await browser.storage.session.get(ENTRY_KEY))[ENTRY_KEY];
      const entries: Record<string, string> = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};
      if (visit && entries[tabId] === visit) return;
      if (visit) entries[tabId] = visit; else delete entries[tabId];
      await browser.storage.session.set({ [ENTRY_KEY]: entries });
      if (visit) await prepareLocal(true, stillCurrent);
    });
    void entryWrites.catch(() => {});
  }

  async function config(): Promise<{ settings: Settings; apiKey: string; remembered: boolean }> {
    await ready;
    const [local, session] = await Promise.all([browser.storage.local.get([SETTINGS_KEY, KEY_STORAGE_KEY, MODEL_CATALOG_KEY]), browser.storage.session.get(KEY_STORAGE_KEY)]);
    const settings = normalizeSettings(local[SETTINGS_KEY], { stored: true });
    const origin = configuredOrigin(settings);
    const value = (record: any): string => origin && record?.origin === origin && typeof record.value === 'string' ? record.value : '';
    const localKey = value(local[KEY_STORAGE_KEY]);
    const apiKey = value(session[KEY_STORAGE_KEY]) || localKey;
    if (local[MODEL_CATALOG_KEY]) await attachModelReasoning(settings, apiKey);
    return { settings, apiKey, remembered: !!localKey };
  }
  async function attachModelReasoning(settings: Settings, apiKey: string): Promise<void> {
    delete settings.modelReasoning;
    if (!apiKey || !settings.endpoint || !settings.model) return;
    const catalog = await catalogs.read(await modelCatalogScope(settings, apiKey));
    const effort = selectModelEffort(catalog, settings.model);
    if (effort && catalog) settings.modelReasoning = { model: settings.model, endpoint: settings.endpoint, fetchedAt: catalog.fetchedAt, effort };
  }
  /** Submitted capability fields are untrusted; resolve against the actual destination/key. */
  async function normalizeSubmittedSettings(value: unknown, submittedKey?: unknown): Promise<Settings> {
    if (submittedKey !== undefined && (typeof submittedKey !== 'string' || submittedKey.length > 4096 || /[\r\n]/.test(submittedKey)))
      throw new Error('API Key 格式无效');
    const draft = normalizeSettings(value, { stored: true });
    const existing = await config();
    const origin = configuredOrigin(draft);
    const apiKey = typeof submittedKey === 'string' && submittedKey || (origin && configuredOrigin(existing.settings) === origin ? existing.apiKey : '');
    await attachModelReasoning(draft, apiKey);
    if (hybridEnabled(draft)) normalizeSettings({ ...draft, backend: 'online' }, { modelReasoning: draft.modelReasoning });
    return normalizeSettings(value, { modelReasoning: draft.modelReasoning });
  }
  let settingsWrites: Promise<unknown> = Promise.resolve();
  function serializeSettingsWrite<T>(operation: () => Promise<T>): Promise<T> {
    const write = settingsWrites.catch(() => {}).then(operation);
    settingsWrites = write.then(() => undefined, () => undefined);
    return write;
  }
  function updateSettings(change: (latest: Settings) => Settings | Promise<Settings>): Promise<Settings> {
    return serializeSettingsWrite(async () => {
      const next = await change((await config()).settings);
      const saved = next.modelReasoning ? { ...next } : next;
      delete saved.modelReasoning;
      await browser.storage.local.set({ [SETTINGS_KEY]: saved }); return next;
    });
  }
  async function safeConfig() {
    const { settings, apiKey, remembered } = await config();
    const hybridIdentity = hybridEnabled(settings) ? await hybridCapacityIdentity(settings) : undefined;
    return { ok: true, settings, onlineBudget: await onlineBudget.read(settings.onlineRequestLimitPerDay), hasKey: settings.backend === 'local' ? !!settings.localModelId : !!apiKey, hasOnlineKey: !!apiKey, remembered, configVersion: version, performancePaused: !!testPause,
      hasHybridConfig: !!settings.localModelId && !!hybridIdentity && !!settings.bilibiliHybrid?.profiles.some(profile => profile.identity === hybridIdentity),
      ...(settings.backend === 'local' || hybridEnabled(settings) ? { localRuntime: await localLoader.status() } : {}) };
  }
  async function reconcileLocalSources() {
    let affected = false, resetTranslations = false;
    // Selection and reconciliation share a queue. Do not retire a newer choice
    // against a catalog snapshot captured before that choice was saved.
    await updateSettings(async latest => {
      const listed = await localControl({ action: 'list' });
      if (!listed.ok) throw new Error(listed.error ?? 'LOCAL_STORAGE_UNAVAILABLE');
      if (latest.localModelId) {
        const model = listed.models?.find(model => model.id === latest.localModelId);
        if (!model || model.availability && model.availability !== 'ready') {
          affected = true;
          resetTranslations = latest.backend === 'local';
          const revision = await localLoader.setPaused(true);
          if (latest.backend === 'local') cancelAll(false);
          const stopped = await localControl({ action: 'unload', policyRevision: revision } as any);
          await localLoader.observe(stopped.state);
          // An unavailable grant is recoverable. A retired file identity must never select a replacement.
          const retire = !model || ['missing', 'changed'].includes(model.availability ?? '');
          return retire ? { ...latest, localModelId: '' } : latest;
        }
      }
      await localLoader.observe(listed.state);
      return latest;
    });
    if (affected) await broadcast(resetTranslations);
    await browser.runtime.sendMessage({ type: 'local-models-updated' }).catch(() => {});
  }
  function trustedUi(sender: Sender): boolean {
    if (sender.id !== browser.runtime.id) return false;
    try {
      // Settings categories use a fragment; keep the exact extension document allowlist.
      const url = new URL(sender.url ?? ''); url.hash = '';
      if (![browser.runtime.getURL('/options.html'), browser.runtime.getURL('/popup.html'), browser.runtime.getURL('/model-folders.html')].includes(url.href)) return false;
      return !sender.tab || sender.frameId === 0 || /^(?:chrome|edge):\/\/extensions(?:\/|\?|$)/.test(sender.tab.url ?? '');
    } catch { return false; }
  }
  function trustedBuildIdentityUi(sender: Sender): boolean {
    if (trustedUi(sender)) return true;
    if (sender.id !== browser.runtime.id || sender.frameId !== 0) return false;
    try {
      const url = new URL(sender.url ?? ''); url.hash = '';
      return url.href === browser.runtime.getURL('/dispatch-runner.html');
    } catch { return false; }
  }
  function contentTab(sender: Sender): number | null {
    if (sender.id !== browser.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || sender.tab!.id! < 0) return null;
    // Chromium retains the injection URL in sender.url after same-document navigation.
    // It establishes the document's origin, not the currently selected video.
    try { if (!['https://www.nicovideo.jp', 'https://www.youtube.com', 'https://live.nicovideo.jp', 'https://www.bilibili.com', 'https://live.bilibili.com'].includes(new URL(sender.url ?? '').origin)) return null; }
    catch { return null; }
    const id = sender.tab!.id!;
    if (!tabs.has(id)) tabs.set(id, { lastSeen: Date.now() });
    tabs.get(id)!.lastSeen = Date.now(); return id;
  }
  async function embeddedUi(sender: Sender, connect: boolean) {
    const token = settingsFrameToken(sender.url ?? '', browser.runtime.getURL('/'));
    if (sender.id !== browser.runtime.id || !token || !Number.isInteger(sender.tab?.id) || !sender.documentId || !(sender.frameId! > 0)) return;
    const tabId = sender.tab!.id!, grant = await frameGrants.get(tabId);
    if (!grant || grant.token !== token || (!grant.documentId && (!connect || Date.now() - grant.createdAt > 60_000))) return;
    if (grant.documentId && (grant.documentId !== sender.documentId || grant.frameId !== sender.frameId)) return;
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab || settingsHostOrigin(tab.url ?? '') !== grant.origin) return;
    const proof = await browser.tabs.sendMessage(tabId, { type: 'settings-host-probe' }, { frameId: 0 }).catch(() => null);
    if (!proof?.ok || proof.hostDocument !== grant.hostDocument || proof.token !== token) return;
    if (!grant.documentId) { grant.documentId = sender.documentId; grant.frameId = sender.frameId; await frameGrants.put(grant); }
    return grant;
  }
  async function currentVideo(tabId: number): Promise<string | null> {
    try { const resource = await currentResource(tabId); return resource?.scenario === 'video' ? resource.resourceId : null; }
    catch { return null; }
  }
  async function currentResource(tabId: number) {
    try {
      const url = (await browser.tabs.get(tabId)).url ?? '', candidate = resourceFromUrl(url);
      if (candidate?.platform !== 'bilibili') return candidate;
      const session = tabs.get(tabId)?.session;
      return session && matchesResourceUrl(session, url) ? session : null;
    } catch { return null; }
  }
  async function diagnosticReply(tabId: number, message: Record<string, unknown>): Promise<any> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        browser.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => null),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1000); }),
      ]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  const experimentRange = (value: any): boolean => Number.isSafeInteger(value?.fromMs) && value.fromMs >= 0 &&
    Number.isSafeInteger(value?.toMs) && value.toMs > value.fromMs && value.toMs <= 86_400_000 &&
    Number.isSafeInteger(value?.prefetchSeconds) && value.prefetchSeconds >= 5 && value.prefetchSeconds <= 3600;
  const sameExperimentRange = (left: ExperimentRange, right: ExperimentRange) =>
    left.fromMs === right.fromMs && left.toMs === right.toMs && left.prefetchSeconds === right.prefetchSeconds;
  const ordinaryExperimentIdle = () => {
    const stats = engine.stats();
    return !stats.pendingItems && !stats.activeRequests && !running.size &&
      !testPause && !modelTest && performanceTest?.report.state !== 'running' && !localChoiceLoading;
  };
  async function experimentScope(tabId: number, sender: Sender, resourceId?: string) {
    const url = (await browser.tabs.get(tabId).catch(() => null))?.url ?? '';
    const tab = tabs.get(tabId), session = tab?.session;
    if (!auditUrl(url) || !auditUrl(sender.url ?? '') || !sender.documentId || tab?.documentId !== sender.documentId ||
        !validSession(session) || session.platform !== 'bilibili' || session.scenario !== 'video' ||
        resourceId !== undefined && session.resourceId !== resourceId || !matchesResourceUrl(session, url)) return null;
    const proof = await browser.tabs.sendMessage(tabId, { type: 'verify-resource-session', session },
      { documentId: sender.documentId, frameId: 0 }).catch(() => null);
    const current = (await browser.tabs.get(tabId).catch(() => null))?.url ?? '';
    return proof?.ok === true && auditUrl(current) && matchesResourceUrl(session, current) &&
      tabs.get(tabId)?.documentId === sender.documentId && sameSession(tabs.get(tabId)?.session, session)
      ? { session, documentId: sender.documentId } : null;
  }
  function experimentItems(value: any): ExperimentItem[] | null {
    if (!value?.ok || !Array.isArray(value.items) || value.items.length > 5000 ||
        !validSession(value.session) || value.session.platform !== 'bilibili' || value.session.scenario !== 'video') return null;
    const ids = new Set<string>(), items: ExperimentItem[] = [];
    for (const row of value.items) {
      if (typeof row?.id !== 'string' || !row.id || row.id.length > 400 || ids.has(row.id) ||
          typeof row.text !== 'string' || !row.text || row.text.length > 1000 ||
          !Number.isFinite(row.mediaTimeMs) || typeof row.translationEligible !== 'boolean') return null;
      ids.add(row.id); items.push({ id: row.id, text: row.text, mediaTimeMs: row.mediaTimeMs,
        translationEligible: row.translationEligible });
    }
    return items;
  }
  function stopExperiment(tabId: number, reason: 'range-complete' | 'manual' | 'context-changed' | 'cancelled' | 'dispatch-policy-violation', notify = true) {
    const run = experimentRuns.get(tabId);
    if (!run) return;
    experimentRuns.delete(tabId);
    for (const controller of run.requests.values()) controller.abort();
    run.requests.clear(); run.experiment.stop(reason === 'dispatch-policy-violation' ? 'context-changed' : reason);
    experimentReports.set(tabId, run);
    if (notify) void browser.tabs.sendMessage(tabId, { type: 'bilibili-experiment-stop', runId: run.runId },
      { documentId: run.documentId, frameId: 0 }).catch(() => {});
  }
  function experimentSnapshot(run: ExperimentRun) {
    const report = run.experiment.snapshot();
    return { ok: true, report: run.dispatch.violationReason
      ? { ...report, state: 'stopped', stopReason: 'dispatch-policy-violation', incomplete: true } : report,
      dispatch: structuredClone(run.dispatch), watchEvents: structuredClone(run.watchEvents),
      watchEventsTruncated: run.watchEventsTruncated };
  }
  async function readAdapterDiagnostic(tabId: number, candidate: string): Promise<AdapterDiagnostic | null> {
    const requestId = crypto.randomUUID();
    const reply = await diagnosticReply(tabId, { type: 'get-adapter-diagnostic', requestId, urlResourceId: candidate });
    if (!reply) return adapterDiagnostic(candidate, 'content-unresponsive');
    const diagnostic = parseAdapterDiagnostic(reply.diagnostic, candidate);
    if (!diagnostic || reply.ok !== true || reply.requestId !== requestId || typeof reply.documentSession !== 'string' ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(reply.documentSession)) return null;
    // Same-URL reload/BFCache replacement: ask the CURRENT document, not the old respondent.
    const proof = await diagnosticReply(tabId, { type: 'verify-adapter-diagnostic', requestId, urlResourceId: candidate,
      documentSession: reply.documentSession, diagnostic });
    return proof?.ok === true ? diagnostic : null;
  }
  function liveSessionMatches(tabId: number, sender: Sender, session: unknown): session is ResourceSession {
    const tab = tabs.get(tabId);
    return validSession(session) && (session.scenario === 'live' || session.platform === 'bilibili') &&
      sameSession(tab?.session, session) && tab?.documentId === sender.documentId &&
      new URL(sender.url!).origin === resourceOrigin(session);
  }
  type PlannedDue = { sourceId: string; epoch: number; predictionEpoch: number;
    ruleRevision: string | number; deadlineAtEpochMs: number; deadlineAt: number };
  function plannedDueItems(message: any, session: ResourceSession | undefined,
    receivedAt: number, receivedNow: number, configVersion: number): Map<string, PlannedDue> | null {
    const planning = message.planning;
    if (!session || session.platform !== 'bilibili' || session.scenario !== 'video' ||
        !Number.isSafeInteger(planning?.epoch) || planning.epoch < 0 ||
        message.configVersion !== configVersion ||
        planning.configIdentity !== `${configVersion}:${session.generation}` ||
        typeof planning.configIdentity !== 'string' || planning.configIdentity.length > 100 ||
        !Number.isFinite(message.sentAt) || message.sentAt <= 0 || message.sentAt > receivedAt + 1000 ||
        receivedAt - message.sentAt > 60_000 || message.force === true || message.forceTranslate === true ||
        message.repairPurpose !== undefined) return null;
    const due = new Map<string, PlannedDue>();
    for (const item of message.items) {
      if (typeof item?.id !== 'string' || due.has(item.id) ||
          typeof item.sourceId !== 'string' || !item.sourceId || item.sourceId.length > 100 ||
          item.id !== bilibiliSourceEventId(session.resourceId, item.sourceId) ||
          item.epoch !== planning.epoch || !Number.isSafeInteger(item.predictionEpoch) || item.predictionEpoch < 0 ||
          item.configIdentity !== planning.configIdentity ||
          !(typeof item.ruleRevision === 'string' && item.ruleRevision.length > 0 && item.ruleRevision.length <= 100 ||
            Number.isSafeInteger(item.ruleRevision) && item.ruleRevision >= 0) ||
          !Number.isFinite(item.deadlineAtEpochMs) || item.deadlineAtEpochMs <= 0 ||
          item.deadlineAtEpochMs > receivedAt + 61_000 ||
          !Number.isFinite(item.remainingMs) || item.remainingMs <= 0 || item.remainingMs > 60_000 ||
          item.deadlineAtEpochMs > message.sentAt + item.remainingMs + 1000 ||
          item.strategy !== undefined && item.strategy !== 'normal' || item.emoteTokens !== undefined) return null;
      const deadlineAt = Math.min(
        localDeadline(item.remainingMs, message.sentAt, receivedAt, receivedNow, 60_000),
        receivedNow + Math.max(0, item.deadlineAtEpochMs - receivedAt));
      due.set(item.id, { sourceId: item.sourceId, epoch: item.epoch,
        predictionEpoch: item.predictionEpoch, ruleRevision: item.ruleRevision,
        deadlineAtEpochMs: item.deadlineAtEpochMs, deadlineAt });
    }
    return due;
  }
  function retireTab(tabId: number) {
    void livePreviewHost.stopForTab(tabId, 'owner-tab-retired');
    void nativeSupplyHost.stopForTab(tabId, 'owner-tab-retired');
    void ownedSupplyHost.stopForTab(tabId, 'owner-tab-retired');
    experimentPreviews.delete(tabId);
    const starting = experimentStarting.get(tabId); if (starting) starting.cancelled = true;
    stopExperiment(tabId, 'context-changed');
    const tab = tabs.get(tabId); if (tab) { tab.session = undefined; tab.status = undefined; }
    engine.setLiveSession(`tab:${tabId}`, false);
    for (const [key, controller] of running) if (key.startsWith(`${tabId}:`)) { controller.abort(); running.delete(key); liveRunning.delete(key); }
  }
  const videoChanging = () => ({ ok: false, error: '视频正在切换，稍后继续准备', retryAfterMs: 500 });
  function cancelPerformanceBatch(reason: 'PERFORMANCE_BATCH_STOPPED' | 'PERFORMANCE_BATCH_CONFIG_CHANGED') {
    const batch = performanceBatch;
    if (!batch || batch.state !== 'running') return;
    batch.cancelled = true; batch.cancelReason = reason; batch.phase = 'finishing';
    if (testPause?.kind === 'performance') testPause.cancelled = true;
    performanceTest?.stop(reason === 'PERFORMANCE_BATCH_CONFIG_CHANGED' ? '配置已变化' : '用户停止');
    // Offscreen unload revokes an in-flight source read, worker load or inference immediately.
    // The queue also unloads at its final boundary, so a delayed load cannot survive cleanup.
    if (testPause?.kind === 'performance') void localControl({ action: 'unload' }).then(reply => localLoader.observe(reply.state)).catch(() => {});
  }
  function cancelAll(stopTest = true) {
    void livePreviewHost.stop('configuration-changed');
    void nativeSupplyHost.stop('configuration-changed');
    void ownedSupplyHost.stop('configuration-changed');
    experimentPreviews.clear();
    for (const starting of experimentStarting.values()) starting.cancelled = true;
    for (const tabId of experimentRuns.keys()) stopExperiment(tabId, 'context-changed');
    version++; credentialRejected = false;
    modelLookup?.abort();
    modelTest?.abort();
    cancelPerformanceBatch('PERFORMANCE_BATCH_CONFIG_CHANGED');
    if (stopTest) {
      if (testPause?.kind === 'performance') testPause.cancelled = true;
      performanceTest?.stop('配置已变化');
    }
    for (const controller of running.values()) controller.abort();
    running.clear(); liveRunning.clear(); engine.resetFailureState();
    for (const tabId of tabs.keys()) engine.setLiveSession(`tab:${tabId}`, false);
  }
  async function broadcast(resetTranslations = false) {
    const safe = await safeConfig();
    const message = { type: 'settings-updated', ...safe, resetTranslations };
    await Promise.allSettled([
      ...[...tabs.keys()].map(tabId => browser.tabs.sendMessage(tabId, message, { frameId: 0 })),
      browser.runtime.sendMessage(message),
    ]);
  }

  async function releaseTest(lease: TestLease, restoreLocal = true) {
    if (lease.releasing) return lease.releasing;
    if (testPause !== lease) return;
    lease.releasing = (async () => {
      // Polling and the completion event may race; only one release may remove this lease.
      await browser.storage.session.remove(TEST_PAUSE_KEY);
      if (testPause !== lease) return;
      testPause = undefined; lease.release(); version++;
      await broadcast(); if (restoreLocal) void prepareLocal();
    })();
    try { await lease.releasing; } catch (error) { lease.releasing = undefined; throw error; }
  }
  async function acquireTest(kind: TestLease['kind']): Promise<TestLease> {
    if (localChoiceLoading) throw new Error('本地模型正在使用中，请结束当前翻译或测试后再试');
    if (testPause || modelTest || performanceTest?.report.state === 'running') throw new Error('已有测试正在运行，请先结束该测试');
    const lease: TestLease = { id: crypto.randomUUID(), kind, cancelled: false, release: keepAlive() };
    testPause = lease;
    try {
      await browser.storage.session.set({ [TEST_PAUSE_KEY]: { id: lease.id, kind } });
      // Incrementing the generation also revokes admissions still awaiting storage/permissions.
      version++;
      for (const controller of running.values()) controller.abort();
      running.clear(); liveRunning.clear(); engine.resetFailureState();
      for (const tabId of tabs.keys()) engine.setLiveSession(`tab:${tabId}`, false);
      await broadcast();
      return lease;
    } catch (error) { await releaseTest(lease); throw error; }
  }
  async function drainTranslations(lease: TestLease, native: boolean) {
    const deadline = Date.now() + 30_000;
    while (testPause === lease && !lease.cancelled) {
      const stats = engine.stats();
      const reply = native ? await localControl({ action: 'state' }) : undefined;
      if (reply && !reply.ok) throw new Error('无法确认本地模型空闲，请稍后重试');
      const state = reply?.state;
      if (!stats.pendingItems && !stats.activeRequests && !state?.active && !state?.queued && !['loading','warming','generating'].includes(state?.phase ?? '')) return;
      if (Date.now() >= deadline) throw new Error('现有翻译尚未退出，未开始测试；请稍后重试');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('测试已取消');
  }
  function batchError(code: string) { return new Error(code); }
  async function runPerformanceBatch(batch: PerformanceBatch, settings: Settings, config: ReturnType<typeof validatePerformanceConfig>) {
    let lease: TestLease | undefined;
    let previousPause: boolean | undefined;
    let leaseVersion = -1;
    let policyRevision: number | undefined;
    const cancelled = () => batch.cancelled || !!lease?.cancelled;
    const unload = async () => {
      const reply = await localControl({ action: 'unload', policyRevision } as any);
      await localLoader.observe(reply.state);
      if (!reply.ok && !cancelled()) throw batchError('PERFORMANCE_BATCH_UNLOAD_FAILED');
    };
    try {
      // Reserve the pause synchronously with the queued start before any model-list IPC.
      // A stop during that IPC cannot race a separate local load or model test.
      lease = await acquireTest('performance');
      leaseVersion = version;
      if (cancelled()) return;
      const listed = await localControl({ action: 'list' });
      if (cancelled()) return;
      if (!listed.ok || !listed.models) throw batchError('PERFORMANCE_BATCH_MODEL_LIST_FAILED');
      for (const [index, id] of batch.modelIds.entries()) {
        batch.index = index;
        batch.modelId = id;
        batch.modelName = listed.models.find(model => model.id === id)?.name ?? id;
        if (!listed.models.some(model => model.id === id && (!model.availability || model.availability === 'ready')))
          throw batchError('PERFORMANCE_BATCH_MODEL_NOT_READY');
      }
      batch.modelId = batch.modelIds[0];
      batch.modelName = listed.models.find(model => model.id === batch.modelId)?.name ?? batch.modelId;
      if (cancelled()) return;
      await drainTranslations(lease, true);
      if (cancelled()) return;
      previousPause = (await localLoader.status()).paused;
      policyRevision = await localLoader.setPaused(true);
      if (cancelled()) return;
      for (let index = 0; index < batch.total; index++) {
        batch.index = index; batch.modelId = batch.modelIds[index];
        batch.modelName = listed.models.find(model => model.id === batch.modelId)?.name ?? batch.modelId;
        if (index === 0) { batch.phase = 'unloading'; await unload(); }
        if (cancelled()) return;
        batch.phase = 'loading';
        const selected = { ...settings, localModelId: batch.modelId, localTranslationProfile: undefined };
        let loaded;
        try { loaded = await localControl({ action: 'load', modelId: batch.modelId, config: selected.localPerformance, policyRevision } as any); }
        catch { throw batchError('PERFORMANCE_BATCH_LOAD_FAILED'); }
        await localLoader.observe(loaded.state);
        if (cancelled()) return;
        if (!loaded.ok || loaded.state?.phase !== 'ready' || loaded.state.model?.id !== batch.modelId)
          throw batchError('PERFORMANCE_BATCH_LOAD_FAILED');
        const effective = withLocalRuntime(selected, loaded.state);
        const capacityIdentity = await hybridCapacityIdentity({ ...selected, sourceLanguage: selected.liveSourceLanguage,
          localConcurrency: config.concurrency });
        let run: PerformanceTest;
        try { run = new PerformanceTest(config, effective, 'local-inference', providerOptions(effective)); }
        catch { throw batchError('PERFORMANCE_BATCH_MODEL_UNSUPPORTED'); }
        if (loaded.state.model?.name) run.report.model = loaded.state.model.name;
        run.report.measurement.extensionVersion = browser.runtime.getManifest().version;
        run.report.measurement.capacityIdentity = capacityIdentity;
        if (loaded.state.runtime) run.report.measurement.localRuntime = structuredClone(loaded.state.runtime);
        batchReportIds.add(run.report.id);
        performanceTest = run; performanceSaveState = 'pending';
        localPerformanceBaseline = { id: run.report.id, generation: loaded.state.generation, calls: loaded.state.inferenceCalls };
        batch.phase = 'testing';
        try { await run.run(); }
        catch { run.stop('测试执行失败'); throw batchError('PERFORMANCE_BATCH_TEST_FAILED'); }
        if (cancelled() && run.report.state === 'running') run.stop('用户停止');
        const state = await localControl({ action: 'state' }).catch(() => null);
        run.report.localInferenceCalls = state?.state?.generation === localPerformanceBaseline.generation
          ? state.state.inferenceCalls - localPerformanceBaseline.calls : null;
        batch.phase = 'saving';
        const saveState = await savePerformance(run);
        if (saveState === 'failed') throw batchError('PERFORMANCE_BATCH_SAVE_FAILED');
        batch.phase = 'unloading';
        await unload();
        batch.completed++;
        if (cancelled()) return;
      }
      batch.state = 'completed';
    } catch (error) {
      if (!cancelled()) {
        batch.state = 'failed';
        batch.errorCode = error instanceof Error && /^PERFORMANCE_BATCH_[A-Z_]+$/.test(error.message)
          ? error.message : 'PERFORMANCE_BATCH_PREPARE_FAILED';
      }
    } finally {
      if (batch.state === 'running') batch.state = 'stopped';
      batch.phase = 'finishing';
      if (lease) {
        let unloaded = false;
        try {
          const finalUnload = await localControl({ action: 'unload' });
          await localLoader.observe(finalUnload.state);
          if (!finalUnload.ok) throw batchError('PERFORMANCE_BATCH_UNLOAD_FAILED');
          unloaded = true;
        } catch { batch.state = 'failed'; batch.errorCode = 'PERFORMANCE_BATCH_UNLOAD_FAILED'; }
        // A configuration change owns its newer auto-load policy; do not overwrite it.
        if (unloaded && previousPause !== undefined && version === leaseVersion) {
          try { await localLoader.setPaused(previousPause); }
          catch { batch.state = 'failed'; batch.errorCode ??= 'PERFORMANCE_BATCH_PREPARE_FAILED'; }
        }
        await releaseTest(lease, false).catch(() => {
          batch.state = 'failed'; batch.errorCode ??= 'PERFORMANCE_BATCH_PREPARE_FAILED';
        });
      }
      batch.phase = 'done';
    }
  }
  async function finishLocalBenchmark() {
    const lease = testPause;
    if (lease?.kind !== 'local-benchmark' || !lease.benchmarkId) return;
    const reply = await localControl({ action: 'benchmark-status' });
    if (!reply.ok || reply.report && (!('status' in reply.report) || !['completed','failed','cancelled'].includes(reply.report.status) || reply.report.phase !== 'done')) return;
    if (lease.benchmarkId && reply.report && reply.report.id !== lease.benchmarkId) return;
    const local = await localControl({ action: 'state' });
    await localLoader.observe(local.state);
    await releaseTest(lease);
  }
  const recoveredPause = ready.then(async () => {
    const stored = (await browser.storage.session.get(TEST_PAUSE_KEY))[TEST_PAUSE_KEY] as { kind?: string; id?: string } | undefined;
    if (!stored) return;
    // Online tests die with their worker; native benchmarks survive in the offscreen document.
    if (stored.kind !== 'local-benchmark') { await browser.storage.session.remove(TEST_PAUSE_KEY); return; }
    const lease: TestLease = { id: typeof stored.id === 'string' ? stored.id : crypto.randomUUID(), kind: 'local-benchmark', cancelled: false, release: keepAlive() };
    testPause = lease;
    try {
      const reply = await localControl({ action: 'benchmark-status' });
      if (reply.ok && reply.report && 'status' in reply.report && ['running','stopping'].includes(reply.report.status)) {
        lease.benchmarkId = reply.report.id;
      } else await releaseTest(lease);
    } catch { await releaseTest(lease); }
  });

  async function handle(message: any, sender: Sender): Promise<unknown> {
    const receivedAt = clockStamp(), receivedWallAt = Date.now(), receivedNow = performance.now();
    if (!message || typeof message.type !== 'string') return { ok: false, error: '无效消息' };
    if (message.type === 'local-idle-policy-get') {
      if (sender.id !== browser.runtime.id || sender.tab || sender.url !== browser.runtime.getURL('/offscreen.html')) return { ok: false };
      return { ok: true, policy: localIdlePolicy((await config()).settings) };
    }
    await recoveredPause;
    if (message.type === 'local-benchmark-finished' && sender.id === browser.runtime.id && !sender.tab && sender.url === browser.runtime.getURL('/offscreen.html')) {
      await finishLocalBenchmark(); return { ok: true };
    }
    if (message.type === 'local-sources-updated' && sender.id === browser.runtime.id && !sender.tab && sender.url === browser.runtime.getURL('/offscreen.html')) {
      await reconcileLocalSources(); return { ok: true };
    }
    if (['local-idle-check', 'local-idle-unloaded'].includes(message.type)) {
      if (sender.id !== browser.runtime.id || sender.tab || sender.url !== browser.runtime.getURL('/offscreen.html')) return { ok: false };
      if (message.type === 'local-idle-check') {
        const { settings } = await config();
        const work = engine.stats();
        return { ok: true, idle: settings.localIdleUnloadEnabled && !modelTest && !testPause && performanceTest?.report.state !== 'running'
          && experimentRuns.size === 0 && !livePreviewHost.active && !nativeSupplyHost.active && !ownedSupplyHost.active && (settings.backend !== 'local' || running.size === 0 && !(work.pendingItems > 0) && !(work.activeRequests > 0)) };
      }
      const local = await localControl({ action: 'state' });
      await localLoader.observe(local.state);
      return { ok: true };
    }
    const embedded = await embeddedUi(sender, message.type === 'settings-ui-connect');
    // The development console gets only these existing local lifecycle operations,
    // never the settings, credentials, deletion or arbitrary UI command surface.
    const runnerLocal = !trustedUi(sender) && trustedBuildIdentityUi(sender) &&
      message.type === 'local-control' && ['state', 'list', 'load'].includes(message.control?.action);
    const runnerRead = trustedBuildIdentityUi(sender) && ['settings', 'build-identity', 'bilibili-user-filters-audit', 'bilibili-display-plan-guard', 'bilibili-render-preview-guard', 'bilibili-live-preview-host', 'bilibili-native-supply-host', 'bilibili-owned-supply-host'].includes(message.type);
    if (runnerLocal && message.control.action === 'load') {
      const saved = (await config()).settings;
      if (saved.enabled || saved.backend !== 'local' || !saved.localModelId ||
          message.control.modelId !== saved.localModelId ||
          JSON.stringify(message.control.config) !== JSON.stringify({ ...saved.localPerformance, warmup: false }) ||
          !ordinaryExperimentIdle() || ownedSupplyHost.active ||
          (await browser.storage.local.get(OWNED_SUPPLY_GUARD_KEY))[OWNED_SUPPLY_GUARD_KEY])
        return { ok: false, error: 'runner-requires-selected-idle-local-model' };
      const current = await localControl({ action: 'state' });
      if (!current.ok || !current.state || current.state.active !== 0 || current.state.queued !== 0 ||
          current.state.phase !== 'idle') return { ok: false, error: 'runner-local-model-not-idle' };
    }
    const ui = trustedUi(sender) || !!embedded || runnerLocal || runnerRead; const tabId = embedded ? null : contentTab(sender);
    if (!ui && tabId === null) return { ok: false, error: '不支持的消息来源' };
    if (message.type === 'bilibili-owned-supply-retire') {
      try {
        const tab = tabId === null ? null : tabs.get(tabId);
        const current = tabId === null ? null : await currentResource(tabId);
        if (tabId === null || !sender.documentId || tab?.documentId !== sender.documentId ||
            !validSession(tab.session) || tab.session.platform !== 'bilibili' || tab.session.scenario !== 'video' ||
            !sameSession(tab.session, message.session) || !sameResource(current, tab.session) ||
            new URL(sender.url ?? '').origin !== 'https://www.bilibili.com')
          return { ok: false, error: 'owned-supply-retire-invalid-owner' };
        const stored = await browser.storage.local.get([OWNED_SUPPLY_GRANT_KEY, OWNED_SUPPLY_GUARD_KEY]);
        type RetireGrant = { taskId: string; runId: string; instanceId: string; documentId: string; tabId: number };
        const grant = stored[OWNED_SUPPLY_GRANT_KEY] as Partial<RetireGrant> | undefined;
        const guard = stored[OWNED_SUPPLY_GUARD_KEY];
        if (!grant && !guard) return { ok: true };
        if (!grant || typeof grant.tabId !== 'number' || !Number.isSafeInteger(grant.tabId) || grant.tabId < 0 ||
            !(['taskId', 'runId', 'instanceId', 'documentId'] as const).every(key =>
              typeof grant[key] === 'string' && grant[key].length > 0 && grant[key].length <= 100))
          return { ok: false, error: 'owned-supply-retire-invalid-grant' };
        if (grant.tabId !== tabId && await browser.tabs.get(grant.tabId).catch(() => null))
          return { ok: false, error: 'owned-supply-retire-other-tab' };
        await ownedSupplyHost.retireOwned(grant as RetireGrant);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof ProviderError ? error.code : 'owned-supply-retire-failed' };
      }
    }
    if (message.type === 'bilibili-owned-supply-host') {
      try {
        const trusted = trustedUi(sender);
        const saved = (await config()).settings;
        const tab = tabId === null ? null : tabs.get(tabId);
        const browserTab = tabId === null ? null : await browser.tabs.get(tabId).catch(() => null);
        const content = tabId !== null && sender.documentId &&
          new URL(sender.url ?? '').origin === 'https://www.bilibili.com' &&
          tab?.documentId === sender.documentId &&
          validSession(tab?.session) && tab.session.platform === 'bilibili' && tab.session.scenario === 'video' &&
          !!browserTab && matchesResourceUrl(tab.session, browserTab.url ?? '') &&
          sameResource(tab.session, await currentResource(tabId));
        if (message.action === 'prepare' || message.action === 'resume') {
          if (!content || saved.bilibiliOwnedRelease !== true || saved.enabled ||
              saved.backend !== 'local' || !saved.localModelId)
            return { ok: false, error: 'owned-supply-requires-authorized-idle-local-video' };
          const input = { ...message.input, tabId };
          if (message.action === 'prepare') return await ownedSupplyHost.prepare(input);
          return await ownedSupplyHost.resume({ ...input, documentId: sender.documentId });
        }
        const current = await ownedSupplyHost.status();
        const owner = content && current.grant?.tabId === tabId && current.grant?.documentId === sender.documentId;
        const prior = current.grant;
        const ownerTab = prior ? await browser.tabs.get(prior.tabId).catch(() => null) : null;
        const ownerScope = !prior ? 'none' : owner ? 'current-document' :
          content && prior.tabId === tabId ? 'same-tab-retired' :
          !ownerTab && prior.state === 'stopped' ? 'orphaned' : 'other-tab';
        if (message.action === 'status' || message.action === 'export') {
          if (!content && !trusted) return { ok: false, error: 'owned-supply-invalid-owner' };
          return { ...await ownedSupplyHost.status(trusted && message.action === 'export', true), ownerScope };
        }
        if (message.action === 'retire-stopped') {
          // A closed tab cannot release its persisted guard. Reclaim only its
          // stopped, explicitly observed task; never acquire a live tab's grant.
          if (!content || ownerScope !== 'orphaned' || saved.enabled ||
              saved.bilibiliOwnedRelease !== true || saved.backend !== 'local' || !saved.localModelId ||
              message.previous?.taskId !== prior.taskId || message.previous?.runId !== prior.runId ||
              message.previous?.instanceId !== prior.instanceId)
            return { ok: false, error: 'owned-supply-retired-owner-required' };
          return await ownedSupplyHost.cleanupRetiredOwned(prior);
        }
        if (message.action === 'cleanup' && (owner || trusted || content &&
            current.grant?.tabId === tabId && current.grant?.state === 'stopped'))
          return await ownedSupplyHost.cleanup();
        if (message.action === 'stop' && content && current.grant?.tabId === tabId &&
            current.grant.documentId !== sender.documentId)
          return await ownedSupplyHost.stopForTab(tabId, 'owner-tab-retired');
        if (!owner || !sender.documentId || tabId === null)
          return { ok: false, error: 'owned-supply-content-owner-required' };
        if (message.action === 'stop' || message.action === 'drain')
          return await ownedSupplyHost.stop(message.reason ?? 'manual', message.action === 'drain');
        if (message.action === 'start') return await ownedSupplyHost.start(tabId, sender.documentId, message.runId, message.instanceId);
        if (message.action === 'translate') return await ownedSupplyHost.translate(tabId, sender.documentId, message);
        if (message.action === 'cancel') return await ownedSupplyHost.cancel(tabId, sender.documentId, message);
        return { ok: false, error: 'owned-supply-invalid-action' };
      } catch (error) {
        return { ok: false, error: error instanceof ProviderError ? error.code : 'owned-supply-operation-failed' };
      }
    }
    if (message.type === 'bilibili-native-supply-host') {
      try {
        const trusted = trustedBuildIdentityUi(sender);
        if (message.action === 'prepare' || message.action === 'resume') {
          if (!trusted && (tabId === null || message.action !== 'prepare' || !(await config()).settings.bilibiliNativeTranslationOnly)) return { ok: false, error: 'native-supply-trusted-authorization-required' };
          const input = trusted ? message.input : { ...message.input, tabId };
          if (!trusted && input.authorizedExtraLoad !== undefined)
            return { ok: false, error: 'native-supply-trusted-authorization-required' };
          if (!trusted && !input.modelId) {
            const local = await localControl({ action: 'list' });
            const models = local.models?.filter(model => /hy[-_ ]?mt2[-_ ]?7b(?!\d)/i.test(model.name));
            if (models?.length !== 1) return { ok: false, error: 'native-supply-select-one-registered-7b-model' };
            input.modelId = models![0]!.id;
          }
          return message.action === 'prepare' ? await nativeSupplyHost.prepare(input) : await nativeSupplyHost.resume(input);
        }
        const current = await nativeSupplyHost.status();
        const owned = current.grant && tabId === current.grant.tabId && sender.documentId === current.grant.documentId;
        if (!trusted && !owned) return { ok: false, error: 'native-supply-invalid-owner' };
        if (message.action === 'status' || message.action === 'export') return nativeSupplyHost.status(trusted && message.action === 'export', true);
        if (message.action === 'cleanup') {
          return await nativeSupplyHost.cleanup();
        }
        if (message.action === 'stop' || message.action === 'drain') return nativeSupplyHost.stop(message.reason ?? 'manual', message.action === 'drain');
        if (!owned || !sender.documentId || tabId === null) return { ok: false, error: 'native-supply-content-owner-required' };
        if (message.action === 'replay') return nativeSupplyHost.replay(tabId, sender.documentId, message);
        if (message.action === 'start') return nativeSupplyHost.start(tabId, sender.documentId, message.runId, message.instanceId);
        if (message.action === 'translate') return nativeSupplyHost.translate(tabId, sender.documentId, message);
        if (message.action === 'cancel') return nativeSupplyHost.cancel(tabId, sender.documentId, message);
        return { ok: false, error: 'native-supply-invalid-action' };
      } catch (error) {
        return { ok: false, error: error instanceof ProviderError ? error.code : 'native-supply-operation-failed' };
      }
    }
    if (message.type === 'bilibili-live-preview-host') {
      try {
        const trusted = trustedBuildIdentityUi(sender);
        if (message.action === 'prepare' || message.action === 'resume') {
          if (!trusted) return { ok: false, error: 'live-preview-trusted-authorization-required' };
          return message.action === 'prepare' ? await livePreviewHost.prepare(message.input) : await livePreviewHost.resume(message.input);
        }
        const current = await livePreviewHost.status();
        const owned = current.grant && tabId === current.grant.tabId && sender.documentId === current.grant.documentId;
        if (!trusted && !owned) return { ok: false, error: 'live-preview-invalid-owner' };
        if (message.action === 'status' || message.action === 'export') return livePreviewHost.status(trusted && message.action === 'export', true);
        if (message.action === 'cleanup') {
          return await livePreviewHost.cleanup();
        }
        if (message.action === 'stop' || message.action === 'drain') return livePreviewHost.stop(message.reason ?? 'manual', message.action === 'drain');
        if (!owned || !sender.documentId || tabId === null) return { ok: false, error: 'live-preview-content-owner-required' };
        if (message.action === 'start') return livePreviewHost.start(tabId, sender.documentId, message.runId, message.instanceId);
        if (message.action === 'translate') return livePreviewHost.translate(tabId, sender.documentId, message);
        if (message.action === 'cancel') return livePreviewHost.cancel(tabId, sender.documentId, message);
        return { ok: false, error: 'live-preview-invalid-action' };
      } catch (error) {
        return { ok: false, error: error instanceof ProviderError ? error.code : 'live-preview-operation-failed' };
      }
    }
    if (message.type === 'bilibili-render-preview-guard') {
      const targetId = tabId ?? (trustedBuildIdentityUi(sender) && Number.isSafeInteger(message.tabId) ? message.tabId : null);
      if (targetId === null || !['prepare', 'status', 'cleanup'].includes(message.action))
        return { ok: false, error: 'render-preview-guard-invalid-source' };
      if (userFilterGuardMutation) return { ok: false, error: 'render-preview-guard-busy' };
      userFilterGuardMutation = true;
      try {
        const stored = await browser.storage.local.get([renderPreviewGuardKey, userFilterGuardKey, OWNED_SUPPLY_GUARD_KEY]);
        const rawGuard = stored[renderPreviewGuardKey], guard = guardFields(rawGuard);
        const owned = guard?.kind === 'render-preview' && guard.tabId === targetId;
        if (rawGuard && !owned) return { ok: false, error: 'render-preview-guard-owned-by-other-task' };
        if (message.action === 'prepare') {
          const resource = await currentResource(targetId);
          if (stored[OWNED_SUPPLY_GUARD_KEY] || resource?.platform !== 'bilibili' || resource.scenario !== 'video' ||
              (await config()).settings.enabled || !ordinaryExperimentIdle() || experimentRuns.size || experimentStarting.size ||
              guardFields(stored[userFilterGuardKey])?.kind === 'display-plan')
            return { ok: false, error: 'render-preview-requires-disabled-idle-video' };
          await browser.storage.local.set({ [renderPreviewGuardKey]: {
            enabled: true, kind: 'render-preview', tabId: targetId, startedAt: guard?.startedAt ?? Date.now(),
          } });
        } else if (message.action === 'cleanup') {
          if (!ordinaryExperimentIdle() || experimentRuns.size || experimentStarting.size)
            return { ok: false, error: 'render-preview-not-idle' };
          if (owned) await browser.storage.local.remove(renderPreviewGuardKey);
        }
        const protections = await renderPreviewProtections();
        return { ok: true, version: browser.runtime.getManifest().version, buildId: BUILD_ID,
          ...protections, zeroModelGuard: protections.temporaryGuard.enabled,
          ...(['prepare', 'cleanup'].includes(message.action) ? { cacheState: await auditCacheState() } : {}),
          ownerTabId: protections.temporaryGuard.ownerTabId, idle: ordinaryExperimentIdle(),
          blockedTransports: userFilterBlockedTransports, actualModelCalls: 0 };
      } finally { userFilterGuardMutation = false; }
    }
    if (message.type === 'bilibili-display-plan-guard') {
      const targetId = tabId ?? (trustedBuildIdentityUi(sender) && Number.isSafeInteger(message.tabId) ? message.tabId : null);
      if (targetId === null || !['prepare', 'status', 'cleanup'].includes(message.action))
        return { ok: false, error: 'display-plan-guard-invalid-source' };
      if (userFilterGuardMutation) return { ok: false, error: 'display-plan-guard-busy' };
      userFilterGuardMutation = true;
      try {
        const otherGuards = await browser.storage.local.get([renderPreviewGuardKey, OWNED_SUPPLY_GUARD_KEY]);
        if (message.action === 'prepare' && otherGuards[OWNED_SUPPLY_GUARD_KEY])
          return { ok: false, error: 'display-plan-guard-owned-by-owned-supply' };
        if (message.action !== 'status' && otherGuards[renderPreviewGuardKey])
          return { ok: false, error: 'display-plan-guard-owned-by-render-preview' };
        let guard = (await browser.storage.local.get(userFilterGuardKey))[userFilterGuardKey] as { kind?: string; tabId?: number; startedAt?: number; enabled?: boolean } | null | undefined;
        const owned = guard?.kind === 'display-plan' && guard.tabId === targetId;
        if (guard && !owned) return { ok: false, error: 'display-plan-guard-owned-by-other-task' };
        if (message.action === 'prepare') {
          const resource = await currentResource(targetId);
          if (resource?.platform !== 'bilibili' || resource.scenario !== 'video' ||
              (await config()).settings.enabled || !ordinaryExperimentIdle() || experimentRuns.size || experimentStarting.size)
            return { ok: false, error: 'display-plan-requires-disabled-idle-video' };
          guard = { enabled: true, kind: 'display-plan', tabId: targetId, startedAt: guard?.startedAt ?? Date.now() };
          await browser.storage.local.set({ [userFilterGuardKey]: guard });
        } else if (message.action === 'cleanup') {
          if (!ordinaryExperimentIdle() || experimentRuns.size || experimentStarting.size)
            return { ok: false, error: 'display-plan-not-idle' };
          if (owned) await browser.storage.local.remove(userFilterGuardKey);
          guard = null;
        }
        return { ok: true, version: browser.runtime.getManifest().version, buildId: BUILD_ID,
          zeroModelGuard: guard?.enabled === true, ownerTabId: guard?.tabId ?? null, idle: ordinaryExperimentIdle(),
          blockedTransports: userFilterBlockedTransports, actualModelCalls: 0 };
      } finally { userFilterGuardMutation = false; }
    }
    if (message.type === 'bilibili-user-filters-audit') {
      if (!trustedBuildIdentityUi(sender) || !['prepare', 'status', 'cleanup'].includes(message.action))
        return { ok: false, error: 'unsupported-user-filter-control' };
      if (userFilterGuardMutation) return { ok: false, error: 'user-filter-guard-busy' };
      userFilterGuardMutation = true;
      try {
      const otherGuards = await browser.storage.local.get([renderPreviewGuardKey, OWNED_SUPPLY_GUARD_KEY]);
      if (message.action === 'prepare' && otherGuards[OWNED_SUPPLY_GUARD_KEY])
        return { ok: false, error: 'user-filter-guard-owned-by-owned-supply' };
      if (message.action !== 'status' && otherGuards[renderPreviewGuardKey])
        return { ok: false, error: 'user-filter-guard-owned-by-render-preview' };
      const existingGuard = (await browser.storage.local.get(userFilterGuardKey))[userFilterGuardKey] as { kind?: string } | undefined;
      if (message.action !== 'status' && existingGuard?.kind === 'display-plan')
        return { ok: false, error: 'user-filter-guard-owned-by-display-plan' };
      if (message.action === 'prepare') {
        if ((await config()).settings.enabled || !ordinaryExperimentIdle() || experimentRuns.size || experimentStarting.size)
          return { ok: false, error: 'user-filter-audit-requires-disabled-idle-translation' };
        await browser.storage.local.set({ [userFilterGuardKey]: { enabled: true, startedAt: Date.now() } });
      } else if (message.action === 'cleanup') {
        if (!ordinaryExperimentIdle() || experimentRuns.size || experimentStarting.size)
          return { ok: false, error: 'user-filter-audit-not-idle' };
        await browser.storage.local.remove(userFilterGuardKey);
      }
      return { ok: true, version: browser.runtime.getManifest().version, buildId: BUILD_ID,
        zeroModelGuard: !!(await browser.storage.local.get(userFilterGuardKey))[userFilterGuardKey],
        blockedTransports: userFilterBlockedTransports, actualModelCalls: 0 };
      } finally { userFilterGuardMutation = false; }
    }
    if (message.type === 'build-identity') {
      if (!trustedBuildIdentityUi(sender)) return { ok: false, error: '不支持的消息来源' };
      return { ok: true, component: 'background', version: browser.runtime.getManifest().version, buildId: BUILD_ID,
        idle: !nativeSupplyHost.active && !livePreviewHost.active && !ownedSupplyHost.active && ordinaryExperimentIdle() && experimentRuns.size === 0 && experimentStarting.size === 0,
        nativeSupply: await nativeSupplyHost.status(),
        ownedSupply: await ownedSupplyHost.status(),
        protections: await renderPreviewProtections() };
    }
    if (message.type === 'settings-ui-connect' && ui) return { ok: true, embedded: !!embedded };
    if (message.type === 'settings-frame-close' && embedded) {
      await frameGrants.remove(embedded.tabId);
      await browser.tabs.sendMessage(embedded.tabId, { type: 'settings-host-close', token: embedded.token, hostDocument: embedded.hostDocument }, { frameId: 0 }).catch(() => {});
      return { ok: true };
    }
    if (message.type === 'settings-close-request' && tabId !== null) {
      const grant = await frameGrants.get(tabId);
      if (!grant || grant.token !== message.token || grant.hostDocument !== message.hostDocument || !grant.documentId) return { ok: false };
      await browser.tabs.sendMessage(tabId, { type: 'settings-frame-close-request', save: message.save === true }, { frameId: grant.frameId!, documentId: grant.documentId }).catch(() => {});
      return { ok: true };
    }
    if (message.type === 'settings') return safeConfig();
    if (message.type === 'translation-shortcut') return { ok: true, shortcut: await getTranslationShortcut(browser.commands) };
    if (message.type === 'bilibili-user-filter-status' && (trustedUi(sender) || embedded)) {
      const sources: { tabId: number; resourceId: string }[] = [];
      for (const id of tabs.keys()) {
        const resource = await currentResource(id);
        if (resource?.platform === 'bilibili' && resource.scenario === 'video') sources.push({ tabId: id, resourceId: resource.resourceId });
      }
      const selected = Number.isSafeInteger(message.tabId) ? sources.find(item => item.tabId === message.tabId)
        : embedded ? sources.find(item => item.tabId === embedded.tabId) : sources.length === 1 ? sources[0] : undefined;
      const disconnected = { connected: false, stale: false, featureEnabled: (await config()).settings.bilibiliUserFilters, summary: null };
      if (!selected) return { ok: true, sources, selectedTabId: null, view: disconnected };
      const captured = tabs.get(selected.tabId)?.session, documentId = tabs.get(selected.tabId)?.documentId;
      const reply = await diagnosticReply(selected.tabId, { type: 'get-bilibili-user-filter-status' });
      const current = await currentResource(selected.tabId);
      if (!reply?.ok || !sameSession(reply.session, captured) || documentId !== tabs.get(selected.tabId)?.documentId ||
          current?.resourceId !== selected.resourceId || reply.view?.resourceId !== selected.resourceId)
        return { ok: true, sources, selectedTabId: selected.tabId, view: { ...disconnected, ...selected } };
      const summary = reply.view.summary ? parseUserFilterSummary({ ...reply.view.summary, enabled: reply.view.summary.nativeEnabled }) : null;
      return { ok: true, sources, selectedTabId: selected.tabId, view: { ...selected,
        connected: reply.view.connected === true, stale: reply.view.stale === true,
        featureEnabled: reply.view.featureEnabled === true, summary } };
    }
    if (message.type === 'bilibili-audit-read' && tabId !== null) {
      const currentUrl = (await browser.tabs.get(tabId)).url ?? '';
      const observed = tabs.get(tabId)?.session;
      if (!auditUrl(currentUrl) || !auditUrl(sender.url ?? '') || tabs.get(tabId)?.documentId !== sender.documentId || !observed || observed.platform !== 'bilibili' ||
          observed.scenario !== 'video' || observed.resourceId !== message.resourceId || !matchesResourceUrl(observed, currentUrl))
        return { ok: false, error: 'audit-scope-not-ready' };
      const { settings } = await config();
      const stats = engine.stats();
      if (settings.enabled || stats.pendingItems || stats.activeRequests || testPause || modelTest || performanceTest)
        return { ok: false, error: 'audit-requires-disabled-idle-translation' };
      if (!Array.isArray(message.texts) || message.texts.length > 200 ||
          message.texts.some((text: unknown) => typeof text !== 'string' || text.length > 1000))
        return { ok: false, error: 'invalid-audit-inputs' };
      const items = await auditCache(settings, observed.resourceId, message.texts);
      return { ok: true, items, configVersion: version, workerSession: auditWorkerSession, engine: { providerCalls: stats.providerCalls, pendingItems: stats.pendingItems,
        activeRequests: stats.activeRequests }, settings: { enabled: settings.enabled, displayMode: settings.displayMode,
        backend: settings.backend, sourceLanguage: settings.sourceLanguage, targetLanguage: settings.targetLanguage,
        localModelId: settings.backend === 'local' ? settings.localModelId ?? null : null,
        translationScope: settings.translationScope, prefetchSeconds: settings.prefetchSeconds, urgentSeconds: settings.urgentSeconds,
        videoBatchSize: videoBatchLimit(settings), maxBatchChars: settings.maxBatchChars, concurrency: settings.concurrency,
        cacheMaxEntries: settings.cacheMaxEntries, cacheTtlDays: settings.cacheTtlDays } };
    }
    if (message.type === 'bilibili-experiment-preview' && tabId !== null) {
      if (!experimentRange(message) || typeof message.resourceId !== 'string' || experimentRuns.has(tabId))
        return { ok: false, error: 'invalid-experiment-preview' };
      const scope = await experimentScope(tabId, sender, message.resourceId);
      if (!scope) return { ok: false, error: 'audit-scope-not-ready' };
      const capturedVersion = version;
      const range = { fromMs: message.fromMs, toMs: message.toMs, prefetchSeconds: message.prefetchSeconds };
      const reply = await browser.tabs.sendMessage(tabId, { type: 'bilibili-experiment-preview', ...range, resourceId: message.resourceId },
        { documentId: scope.documentId, frameId: 0 }).catch(() => null);
      const backgroundVersion = browser.runtime.getManifest().version;
      const backgroundBuildId = BUILD_ID;
      if (reply?.ok === true && (reply.version !== backgroundVersion || reply.buildId !== backgroundBuildId))
        return { ok: false, error: 'experiment-build-mismatch', buildIdentity: { backgroundVersion, backgroundBuildId,
          watchVersion: reply.version ?? null, watchBuildId: reply.buildId ?? null } };
      const items = experimentItems(reply);
      if (!items || reply.resourceId !== message.resourceId || !sameSession(reply.session, scope.session) ||
          capturedVersion !== version || !await experimentScope(tabId, sender, message.resourceId))
        return { ok: false, error: 'experiment-preview-changed' };
      const { settings } = await config();
      const local = await localControl({ action: 'state' }).catch(() => null);
      if (capturedVersion !== version || !await experimentScope(tabId, sender, message.resourceId))
        return { ok: false, error: 'experiment-preview-changed' };
      const eligible = new Map(items.filter(item => item.translationEligible).map(item => [item.id, item.text]));
      if (experimentPreviews.size >= 8 && !experimentPreviews.has(tabId)) experimentPreviews.delete(experimentPreviews.keys().next().value!);
      experimentPreviews.set(tabId, { range, resourceId: message.resourceId, session: scope.session,
        documentId: scope.documentId, configVersion: capturedVersion, watchVersion: reply.version, watchBuildId: reply.buildId,
        eligible, at: Date.now() });
      const state = local?.ok ? local.state : null;
      const { localSingleItem } = await import('../src/translation/local-policy');
      const singleItem = !!state && localSingleItem(withLocalRuntime(settings, state));
      // The scoped preview exposes only a model identity, not the privileged
      // local-control API or file/handle metadata, to the diagnostic content.
      const modelFingerprint = state?.phase === 'ready' && state.model && state.model.id === settings.localModelId
        ? JSON.stringify({ selectedModelId: settings.localModelId, modelId: state.model.id,
          contentFingerprint: state.model.fingerprint ?? null, architecture: state.model.architecture,
          quantization: state.model.quantization, bytes: state.model.bytes,
          translationProfile: state.model.translationProfile ?? null, runtime: state.runtime ?? null }) : null;
      return { ok: true, session: scope.session, resourceId: message.resourceId, items, configVersion: capturedVersion,
        dispatch: { backgroundVersion, watchVersion: reply.version, backgroundBuildId, watchBuildId: reply.buildId,
          savedBatchLimit: videoBatchLimit(settings), concurrency: settings.concurrency },
        settings: { enabled: settings.enabled, backend: settings.backend, displayMode: settings.displayMode,
          sourceLanguage: settings.sourceLanguage, targetLanguage: settings.targetLanguage,
          localModelId: settings.localModelId ?? null, concurrency: settings.concurrency, videoBatchSize: videoBatchLimit(settings),
          translationScope: settings.translationScope, maxBatchChars: settings.maxBatchChars },
        local: { phase: state?.phase ?? 'unavailable', modelMatched: !!settings.localModelId && state?.model?.id === settings.localModelId,
          generation: state?.generation ?? null, active: state?.active ?? null, queued: state?.queued ?? null, singleItem, modelFingerprint },
        dispatchComparisonReady: settings.backend === 'local' && !settings.enabled && settings.concurrency === 2 && singleItem &&
          state?.phase === 'ready' && state?.model?.id === settings.localModelId && (state?.runtime?.parallel ?? 0) >= 2 &&
          state?.active === 0 && state?.queued === 0 && ordinaryExperimentIdle(),
        engineIdle: ordinaryExperimentIdle() };
    }
    if (message.type === 'bilibili-experiment-start' && tabId !== null) {
      if (typeof message.runId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(message.runId) ||
          !experimentRange(message) || typeof message.filterEnabled !== 'boolean' ||
          (message.singleDispatch !== undefined && typeof message.singleDispatch !== 'boolean') ||
          (message.dispatchComparison !== undefined && typeof message.dispatchComparison !== 'boolean') ||
          (message.singleDispatch === true && message.dispatchComparison !== true) ||
          typeof message.resourceId !== 'string' || experimentRuns.has(tabId) || experimentStarting.has(tabId))
        return { ok: false, error: 'invalid-experiment-start' };
      const starting: { runId: string; cancelled: boolean; expected?: ResourceSession } =
        { runId: message.runId, cancelled: false }; experimentStarting.set(tabId, starting);
      try {
        const prior = experimentPreviews.get(tabId), scope = await experimentScope(tabId, sender, message.resourceId);
        if (!prior || !scope || prior.documentId !== scope.documentId || !sameSession(prior.session, scope.session) ||
            prior.configVersion !== version || prior.resourceId !== message.resourceId ||
            !sameExperimentRange(prior.range, message) || Date.now() - prior.at > 120_000 || starting.cancelled)
          return { ok: false, error: 'experiment-preview-required' };
        const range = { ...prior.range };
        const fresh = await browser.tabs.sendMessage(tabId, { type: 'bilibili-experiment-preview', ...range,
          resourceId: message.resourceId }, { documentId: scope.documentId, frameId: 0 }).catch(() => null);
        const backgroundVersion = browser.runtime.getManifest().version;
        const backgroundBuildId = BUILD_ID;
        if (fresh?.ok === true && (fresh.version !== backgroundVersion || fresh.version !== prior.watchVersion ||
            fresh.buildId !== backgroundBuildId || fresh.buildId !== prior.watchBuildId))
          return { ok: false, error: 'experiment-build-mismatch', buildIdentity: { backgroundVersion, backgroundBuildId,
            watchVersion: fresh.version ?? null, watchBuildId: fresh.buildId ?? null } };
        const freshItems = experimentItems(fresh);
        if (!freshItems || fresh.resourceId !== message.resourceId || !sameSession(fresh.session, scope.session))
          return { ok: false, error: 'experiment-preview-changed' };
        const freshEligible = new Map(freshItems.filter(item => item.translationEligible).map(item => [item.id, item.text]));
        const eligible = new Map([...prior.eligible].filter(([id, text]) => freshEligible.get(id) === text));
        const eligibleTexts = new Set(eligible.values());
        if (!eligibleTexts.size || !Array.isArray(message.allowTexts) || !message.allowTexts.length ||
            message.allowTexts.length > eligibleTexts.size || new Set(message.allowTexts).size !== message.allowTexts.length ||
            message.allowTexts.some((text: unknown) => typeof text !== 'string' || !eligibleTexts.has(text)))
          return { ok: false, error: 'experiment-allowlist-changed' };
        const replay = message.cacheReplay !== undefined;
        if (replay && (message.filterEnabled || !Array.isArray(message.cacheReplay?.entries) ||
            !message.cacheReplay.entries.length || message.cacheReplay.entries.length > 100 ||
            message.cacheReplay.entries.some((entry: any) => !entry ||
              eligible.get(entry.sourceId) !== entry.text)))
          return { ok: false, error: 'invalid-experiment-cache-replay' };
        const budget = message.budget as LocalExperimentBudget;
        const dryChars = [...eligibleTexts].reduce((sum, text) => sum + text.length, 0);
        if (!budget || (replay ? budget.maxInputItems !== 0 || budget.maxInputChars !== 0 || budget.maxAttempts !== 0
          : !Number.isSafeInteger(budget.maxInputItems) || budget.maxInputItems < 1 ||
            budget.maxInputItems > eligibleTexts.size || !Number.isSafeInteger(budget.maxInputChars) ||
            budget.maxInputChars < 1 || budget.maxInputChars > dryChars ||
            !Number.isSafeInteger(budget.maxAttempts) || budget.maxAttempts < 1 || budget.maxAttempts > eligibleTexts.size))
          return { ok: false, error: 'invalid-experiment-budget' };
        const { settings } = await config(), capturedVersion = version;
        if (settings.enabled || settings.backend !== 'local' || !settings.localModelId || !ordinaryExperimentIdle() ||
            ownedSupplyHost.active || (await browser.storage.local.get(OWNED_SUPPLY_GUARD_KEY))[OWNED_SUPPLY_GUARD_KEY] ||
            testPause || starting.cancelled) return { ok: false, error: 'experiment-requires-disabled-idle-local' };
        const local = await localControl({ action: 'state' }).catch(() => null);
        const state = local?.ok ? local.state : null;
        if (!state || state.active !== 0 || state.queued !== 0 || !Number.isSafeInteger(state.generation) ||
            (!replay && (state.phase !== 'ready' || state.model?.id !== settings.localModelId || !state.runtime)))
          return { ok: false, error: 'experiment-local-model-not-loaded' };
        if (message.dispatchComparison === true) {
          const { localSingleItem } = await import('../src/translation/local-policy');
          if (replay || !message.filterEnabled || settings.concurrency !== 2 || !((state.runtime?.parallel ?? 0) >= 2) ||
              !localSingleItem(withLocalRuntime(settings, state)) ||
              range.fromMs !== 52000 || range.toMs !== 67000 || range.prefetchSeconds !== 5 ||
              budget.maxInputItems > 55 || budget.maxInputChars > 600 || budget.maxAttempts > 55)
            return { ok: false, error: 'invalid-dispatch-comparison-context' };
        }
        const savedIdentity = JSON.stringify(settings), runtimeIdentity = JSON.stringify(state.runtime);
        let run!: ExperimentRun;
        const assertCurrent = async () => {
          if (starting.cancelled || capturedVersion !== version || experimentRuns.get(tabId) !== run ||
              !ordinaryExperimentIdle()) throw new Error('experiment-context-changed');
          const current = await experimentScope(tabId, sender, message.resourceId);
          if (!current || current.documentId !== run.documentId || !sameSession(current.session, run.session))
            throw new Error('experiment-document-changed');
          const saved = (await config()).settings;
          if (capturedVersion !== version || JSON.stringify(saved) !== savedIdentity) throw new Error('experiment-config-changed');
          const latest = await localControl({ action: 'state' });
          if (!latest.ok || !latest.state || !ordinaryExperimentIdle() || (replay
            ? latest.state.active !== 0 || latest.state.queued !== 0
            : !['ready', 'generating'].includes(latest.state.phase) ||
              latest.state.model?.id !== settings.localModelId || latest.state.generation !== state.generation ||
              JSON.stringify(latest.state.runtime) !== runtimeIdentity))
            throw new Error('experiment-model-changed');
        };
        const { LocalExperiment } = await import('../src/diagnostics/bilibili-local-experiment');
        const experiment = new LocalExperiment({ settings: Object.freeze({ ...settings }), configVersion: capturedVersion,
          localState: state, resourceId: message.resourceId, runId: message.runId, allowTexts: message.allowTexts,
          budget, assertCurrent, createLocalFetch, ...(replay ? { cacheReplay: message.cacheReplay } : {}) });
        if (starting.cancelled || capturedVersion !== version || !await experimentScope(tabId, sender, message.resourceId))
          return { ok: false, error: 'experiment-context-changed' };
        starting.expected = scope.session;
        const configured = await browser.tabs.sendMessage(tabId, { type: 'bilibili-experiment-configure', ...range,
          runId: message.runId, resourceId: message.resourceId, filterEnabled: message.filterEnabled,
          singleDispatch: message.singleDispatch === true,
          configVersion: capturedVersion }, { documentId: scope.documentId, frameId: 0 }).catch(() => null);
        const configuredSession = configured?.session;
        if (configured?.ok !== true || !validSession(configuredSession) ||
            configuredSession.sessionId !== scope.session.sessionId ||
            configuredSession.generation < scope.session.generation ||
            configuredSession.urlResourceId !== scope.session.urlResourceId ||
            !sameResource(configuredSession, scope.session) ||
            (await browser.tabs.sendMessage(tabId, { type: 'verify-resource-session', session: configuredSession },
              { documentId: scope.documentId, frameId: 0 }).catch(() => null))?.ok !== true)
          return { ok: false, error: 'experiment-watch-not-ready' };
        const effectiveBatchLimit = message.singleDispatch === true ? 1 : videoBatchLimit(settings);
        if (configured.version !== backgroundVersion || configured.version !== prior.watchVersion ||
            configured.buildId !== backgroundBuildId || configured.buildId !== prior.watchBuildId ||
            configured.effectiveBatchLimit !== effectiveBatchLimit ||
            configured.concurrency !== settings.concurrency ||
            configured.singleDispatch !== (message.singleDispatch === true)) {
          await browser.tabs.sendMessage(tabId, { type: 'bilibili-experiment-stop', runId: message.runId },
            { documentId: scope.documentId, frameId: 0 }).catch(() => null);
          return { ok: false, error: 'experiment-dispatch-handshake-mismatch' };
        }
        // The watch's scheduler reset advances its session generation during configure.
        const tab = tabs.get(tabId);
        if (!tab || tab.documentId !== scope.documentId || starting.cancelled ||
            tab.session?.sessionId !== configuredSession.sessionId ||
            (tab.session.generation > configuredSession.generation)) return { ok: false, error: 'experiment-context-changed' };
        tab.session = { ...configuredSession };
        run = { tabId, runId: message.runId, resourceId: message.resourceId, session: configuredSession,
          documentId: scope.documentId, configVersion: capturedVersion, experiment, eligible,
          requestTimeoutMs: providerTimeoutMs(settings),
          requests: new Map(), requestIds: new Set(),
          dispatch: { backgroundVersion, watchVersion: configured.version, backgroundBuildId, watchBuildId: configured.buildId,
            savedBatchLimit: videoBatchLimit(settings), effectiveBatchLimit: configured.effectiveBatchLimit,
            concurrency: configured.concurrency, comparison: message.dispatchComparison === true,
            singleDispatch: message.singleDispatch === true, checkedPackets: 0, admittedPackets: 0,
            rawPacketSizes: {}, peakRequests: 0, violationReason: null },
          watchEvents: [], watchEventsTruncated: false };
        experimentRuns.set(tabId, run);
        try { await experiment.start(); }
        catch {
          stopExperiment(tabId, 'context-changed'); return { ok: false, error: 'experiment-context-changed' };
        }
        experimentPreviews.delete(tabId); experimentReports.delete(tabId);
        return { ...experimentSnapshot(run), runId: run.runId };
      } finally { if (experimentStarting.get(tabId) === starting) experimentStarting.delete(tabId); }
    }
    if (message.type === 'bilibili-experiment-status' && tabId !== null) {
      const run = experimentRuns.get(tabId) ?? experimentReports.get(tabId);
      if (!run || run.runId !== message.runId || run.documentId !== sender.documentId ||
          !await experimentScope(tabId, sender, run.resourceId)) return { ok: false, error: 'experiment-run-not-found' };
      return experimentSnapshot(run);
    }
    if (message.type === 'bilibili-experiment-stop' && tabId !== null) {
      const starting = experimentStarting.get(tabId);
      if (starting && starting.runId === message.runId) starting.cancelled = true;
      const run = experimentRuns.get(tabId) ?? experimentReports.get(tabId);
      if (run && run.runId === message.runId && run.documentId === sender.documentId &&
          await experimentScope(tabId, sender, run.resourceId)) {
        if (experimentRuns.get(tabId) === run)
          stopExperiment(tabId, message.reason === 'range-complete' ? 'range-complete' : 'manual', false);
        // The watch can finish its range before the UI stops observing. It retains
        // the experiment until this document-scoped stop clears it for the next run.
        const watch = await browser.tabs.sendMessage(tabId, { type: 'bilibili-experiment-stop', runId: run.runId },
          { documentId: run.documentId, frameId: 0 }).catch(() => null);
        if (watch?.ok !== true && watch?.error !== 'run-mismatch')
          return { ok: false, error: 'experiment-watch-not-ready' };
        return experimentSnapshot(run);
      }
      return { ok: false, error: 'experiment-run-not-found' };
    }
    if (message.type === 'bilibili-experiment-cancel' && tabId !== null) {
      const run = experimentRuns.get(tabId);
      if (!run || run.runId !== message.runId || !liveSessionMatches(tabId, sender, message.session) ||
          !sameSession(run.session, message.session) || typeof message.requestId !== 'string')
        return { ok: false, error: 'experiment-run-not-found' };
      run.requests.get(message.requestId)?.abort(); run.requests.delete(message.requestId);
      return { ok: true };
    }
    if (message.type === 'bilibili-experiment-stopped' && tabId !== null) {
      const run = experimentRuns.get(tabId);
      if (!run || run.runId !== message.runId || !liveSessionMatches(tabId, sender, message.session) ||
          !sameSession(run.session, message.session)) return { ok: false, error: 'experiment-run-not-found' };
      stopExperiment(tabId, message.reason === 'range-complete' ? 'range-complete' : 'context-changed', false);
      return experimentSnapshot(run);
    }
    if (message.type === 'bilibili-experiment-watch-event' && tabId !== null) {
      const run = experimentRuns.get(tabId) ?? experimentReports.get(tabId);
      if (!run || run.runId !== message.runId || run.documentId !== sender.documentId ||
          !liveSessionMatches(tabId, sender, message.session) || !sameSession(run.session, message.session) ||
          !['stop', 'request-start', 'request-end', 'item-result', 'prepared', 'filter-revision'].includes(message.event) ||
          !Number.isFinite(message.atMs) || message.atMs < 0) return { ok: false, error: 'invalid-experiment-event' };
      const event: Record<string, unknown> = { event: message.event, atMs: message.atMs };
      for (const key of ['requestId', 'reason', 'error', 'priority'] as const)
        if (typeof message[key] === 'string') event[key] = message[key].slice(0, 100);
      if (typeof message.id === 'string') event.id = message.id.slice(0, 400);
      if (typeof message.status === 'string') event.status = message.status.slice(0, 30);
      if (typeof message.text === 'string') event.text = message.text.slice(0, 1000);
      for (const key of ['revision', 'reset', 'ready'] as const)
        if (typeof message[key] === 'boolean' || Number.isSafeInteger(message[key])) event[key] = message[key];
      if (Array.isArray(message.items) && message.items.length <= 200) event.items = message.items.map((item: any) => ({
        id: typeof item?.id === 'string' ? item.id.slice(0, 400) : null,
        ...(typeof item?.text === 'string' ? { text: item.text.slice(0, 1000) } : {}),
        ...(typeof item?.originalText === 'string' ? { originalText: item.originalText.slice(0, 1000) } : {}),
        ...(typeof item?.status === 'string' ? { status: item.status.slice(0, 30) } : {}),
        ...(item?.state === 'filtered' || item?.state === 'unknown' ? { state: item.state } : {}),
      }));
      if (run.watchEvents.length < 512 && JSON.stringify(event).length <= 32_000) run.watchEvents.push(event);
      else run.watchEventsTruncated = true;
      return { ok: true };
    }
    if (message.type === 'bilibili-experiment-translate' && tabId !== null) {
      const run = experimentRuns.get(tabId);
      if (!run || run.runId !== message.runId || run.documentId !== sender.documentId ||
          run.resourceId !== message.resourceId || run.configVersion !== message.configVersion ||
          !sameSession(run.session, message.session) || !liveSessionMatches(tabId, sender, message.session) ||
          !await experimentScope(tabId, sender, run.resourceId) || experimentRuns.get(tabId) !== run)
        return { ok: false, error: 'experiment-context-changed' };
      const rawSize = Array.isArray(message.items) ? message.items.length : 'invalid';
      run.dispatch.checkedPackets++;
      const sizeKey = String(rawSize);
      run.dispatch.rawPacketSizes[sizeKey] = (run.dispatch.rawPacketSizes[sizeKey] ?? 0) + 1;
      const violation = (reason: string) => {
        run.dispatch.violationReason = reason;
        stopExperiment(tabId, 'dispatch-policy-violation');
        return { ok: false, error: 'experiment-dispatch-policy-violation' };
      };
      // Check the entire incoming envelope before item validation can drop or merge anything.
      if (run.dispatch.comparison && run.dispatch.singleDispatch && rawSize !== 1)
        return violation('single-dispatch-raw-packet-size');
      if (typeof message.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(message.requestId) ||
          run.requests.has(message.requestId) || (run.dispatch.comparison && run.requestIds.has(message.requestId)) ||
          run.requests.size >= 20 || !Array.isArray(message.items) ||
          !message.items.length || message.items.length > 200) return { ok: false, error: 'invalid-experiment-batch' };
      // A cancelled request releases its slot immediately; its aborted completion cannot publish
      // results, and requestIds prevents a late duplicate from being admitted as a replacement.
      if (run.dispatch.comparison && run.requests.size >= 2)
        return violation('more-than-two-active-watch-requests');
      const seen = new Set<string>(), items: TranslationInput[] = [];
      for (const input of message.items) {
        if (typeof input?.id !== 'string' || !input.id || input.id.length > 400 || seen.has(input.id) ||
            typeof input.text !== 'string' || run.eligible.get(input.id) !== input.text ||
            typeof input.remainingMs !== 'number' || !Number.isFinite(input.remainingMs) || input.remainingMs <= 0 ||
            input.strategy && input.strategy !== 'normal')
          return { ok: false, error: 'experiment-item-outside-preview' };
        seen.add(input.id); items.push({ id: input.id, text: input.text,
          deadlineAt: performance.now() + Math.min(run.requestTimeoutMs, input.remainingMs), strategy: 'normal' });
      }
      const controller = new AbortController(); run.requests.set(message.requestId, controller);
      if (run.dispatch.comparison) run.requestIds.add(message.requestId);
      run.dispatch.admittedPackets++;
      run.dispatch.peakRequests = Math.max(run.dispatch.peakRequests, run.requests.size);
      const priority = ['near', 'buffered', 'background'].includes(message.priority) ? message.priority : 'background';
      try {
        const response = await run.experiment.translate(items, controller.signal, priority, output => {
          if (experimentRuns.get(tabId) !== run || run.requests.get(message.requestId) !== controller ||
              controller.signal.aborted || version !== run.configVersion || tabs.get(tabId)?.documentId !== run.documentId ||
              !sameSession(tabs.get(tabId)?.session, run.session) || !seen.has(output.id) ||
              !['translated', 'cached'].includes(output.status) || typeof output.text !== 'string' ||
              !output.text.trim() || output.text.length > 2000) return;
          void browser.tabs.sendMessage(tabId, { type: 'bilibili-experiment-result', runId: run.runId,
            requestId: message.requestId, resourceId: run.resourceId, session: run.session,
            configVersion: run.configVersion, output: { id: output.id, text: output.text, status: output.status } },
          { documentId: run.documentId, frameId: 0 }).catch(() => {});
        });
        if (experimentRuns.get(tabId) !== run || controller.signal.aborted || version !== run.configVersion)
          return { ok: false, error: 'experiment-context-changed' };
        return { ok: true, ...response };
      } catch {
        if (run.experiment.snapshot().stopReason === 'context-changed') stopExperiment(tabId, 'context-changed');
        return { ok: false, error: 'experiment-request-blocked' };
      } finally { if (run.requests.get(message.requestId) === controller) run.requests.delete(message.requestId); }
    }
    if (message.type === 'session-open' && tabId !== null) {
      const observedSession = tabs.get(tabId)!.session;
      const incoming = message.session;
      const url = (await browser.tabs.get(tabId)).url ?? '';
      if (!validSession(incoming) || !matchesResourceUrl(incoming, url) || (incoming.scenario !== 'live' && incoming.platform !== 'bilibili') ||
          new URL(sender.url!).origin !== resourceOrigin(incoming)) return videoChanging();
      // Verify the isolated script in the CURRENT top document. sender.documentId alone is a send-time snapshot.
      const proof = await browser.tabs.sendMessage(tabId, { type: incoming.scenario === 'video' ? 'verify-resource-session' : 'verify-live-session', session: incoming }, { frameId: 0 }).catch(() => null);
      if (proof?.ok !== true || !matchesResourceUrl(incoming, (await browser.tabs.get(tabId)).url ?? '')) return videoChanging();
      const tab = tabs.get(tabId)!;
      if (tab.session !== observedSession && !sameSession(tab.session, incoming)) return videoChanging();
      if (tab.session && tab.documentId === sender.documentId && tab.session.sessionId === incoming.sessionId && incoming.generation < tab.session.generation) return videoChanging();
      if (!sameSession(tab.session, incoming) || tab.documentId !== sender.documentId) {
        const starting = experimentStarting.get(tabId), expected = starting?.expected;
        const configuring = !starting?.cancelled && expected && tab.documentId === sender.documentId &&
          expected.sessionId === incoming.sessionId && expected.urlResourceId === incoming.urlResourceId &&
          incoming.generation >= expected.generation && sameResource(expected, incoming);
        if (!configuring) retireTab(tabId);
        tab.session = { ...incoming }; tab.documentId = sender.documentId;
        const captured = tab.session;
        prepareEntry(tabId, JSON.stringify([sender.documentId, captured]), () => tab.session === captured && tab.documentId === sender.documentId);
      }
      // Only the first verified entry is demand; repeated session/presence heartbeats stay passive.
      return { ok: true, configVersion: version };
    }
    if (message.type === 'live-presence' && tabId !== null) {
      if (!liveSessionMatches(tabId, sender, message.session) || message.session.scenario !== 'live' || !sameResource(await currentResource(tabId), message.session)) return videoChanging();
      engine.setLiveSession(`tab:${tabId}`, !testPause && message.active === true);
      return { ok: true };
    }
    if (message.type === 'session-close' && tabId !== null) {
      if (liveSessionMatches(tabId, sender, message.session)) retireTab(tabId);
      return { ok: true };
    }
    if (message.type === 'status' && tabId !== null) {
      const s = message.status;
      const resource = await currentResource(tabId), resourceId = resource?.resourceId;
      if (!resource || s?.resourceId !== resourceId || ((resource.scenario === 'live' || resource.platform === 'bilibili') && !liveSessionMatches(tabId, sender, message.session))) return { ok: true };
      if (s && typeof s === 'object' && typeof s.state === 'string') {
        const safe: RuntimeStatus = {
          state: ['unsupported','finding-player','ready','disabled','configuration-needed','translating','degraded'].includes(s.state) ? s.state : 'degraded',
          resourceId, platform: resource.platform, scenario: resource.scenario, messages: 0, translated: 0, original: 0, cacheHits: 0, queued: 0,
          note: typeof s.note === 'string' ? s.note.slice(0, 180) : '',
        };
        for (const key of ['messages','translated','original','cacheHits','queued','prepared','failed','nearTotal','nearPrepared','inflight','recentEligible','recentTranslated','timedOut','overloaded','dropped'] as const) if (Number.isFinite(s[key]) && s[key] >= 0) safe[key] = Math.min(1e9, Math.floor(s[key]));
        if (resource.scenario === 'live') {
          safe.connection = ['connecting','connected','reconnecting','disconnected','ended'].includes(s.connection) ? s.connection : 'disconnected';
          safe.coverage = ['all','top'].includes(s.coverage) ? s.coverage : 'unknown';
          if (resource.platform === 'youtube' || resource.platform === 'bilibili') safe.liveMetrics = nativeMetrics(s.liveMetrics);
          delete safe.prepared; delete safe.nearTotal; delete safe.nearPrepared;
        } else {
          for (const key of ['videoCandidates', 'videoFiltered', 'videoEligibilityUnknown'] as const) if (Number.isFinite(s[key]) && s[key] >= 0) safe[key] = Math.min(1e9, Math.floor(s[key]));
          if (['all', 'window'].includes(s.videoEffectiveScope)) safe.videoEffectiveScope = s.videoEffectiveScope;
          if (['visible', 'hidden', 'unknown'].includes(s.videoDisplayState)) safe.videoDisplayState = s.videoDisplayState;
        }
        safe.sourceComplete = s.sourceComplete === true;
        const tab = tabs.get(tabId)!;
        const enteredVideo = resource.platform === 'niconico' && resource.scenario === 'video'
          && (tab.status?.resourceId !== resourceId || tab.documentId !== sender.documentId);
        tab.status = safe;
        if (enteredVideo) {
          tab.documentId = sender.documentId;
          prepareEntry(tabId, JSON.stringify([sender.documentId, resourceId]), () => tab.status?.resourceId === resourceId && tab.documentId === sender.documentId);
        }
      }
      const engineStats = engine.stats();
      const hybridStreamFailure = resource.platform === 'bilibili' && resource.scenario === 'video'
        && engineStats.lastError?.reason === 'hybrid-stream-unsupported'
        && hybridEnabled((await config()).settings) && (await config()).settings.bilibiliHybrid?.onlineStreaming === true;
      return { ok: true, performancePaused: !!testPause, engineNotice: engineStats.rateLimitedUntil ? '翻译服务限流，等待后继续准备'
        : hybridStreamFailure ? 'hybrid-stream-unsupported' : '',
        ...(resource.platform === 'bilibili' && resource.scenario === 'video' ? { hybridStats: engineStats.hybrid } : {}) };
    }
    if (message.type === 'cancel-video-items' && tabId !== null && typeof message.requestId === 'string' &&
        liveSessionMatches(tabId, sender, message.session) && message.session?.scenario === 'video' &&
        Array.isArray(message.ids) && message.ids.length <= 200 &&
        message.ids.every((id: unknown) => typeof id === 'string' && id.length <= 400)) {
      const controller = running.get(`${tabId}:${message.requestId}`);
      if (controller) {
        const revoked = revokedVideoItems.get(controller) ?? new Set<string>();
        for (const id of message.ids) if (revoked.size < 200) revoked.add(id);
        revokedVideoItems.set(controller, revoked);
        engine.cancelItems(controller.signal, message.ids);
      }
      return { ok: true };
    }
    if (message.type === 'cancel' && tabId !== null && typeof message.requestId === 'string') {
      const key = `${tabId}:${message.requestId}`; running.get(key)?.abort(); running.delete(key); liveRunning.delete(key); return { ok: true };
    }
    if (message.type === 'translate' && tabId !== null) {
      if (testPause) return { ok: false, error: '性能测试中，翻译暂时暂停', retryAfterMs: 1000 };
      const requestVersion = version;
      const requestId = message.requestId;
      const repairPurpose = message.repairPurpose;
      let chatSender = false;
      try { chatSender = ['https://www.youtube.com', 'https://live.bilibili.com', 'https://live.nicovideo.jp'].includes(new URL(sender.url!).origin); } catch { /* contentTab already rejected unsupported origins */ }
      const repairRequest = chatSender && ['manual', 'superchat', 'pinned', 'timeout'].includes(repairPurpose) &&
        typeof requestId === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(requestId) && liveSessionMatches(tabId, sender, message.session);
      const videoRequest = !chatSender && resourceFromUrl(sender.url ?? '')?.scenario === 'video' &&
        typeof requestId === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(requestId);
      const key = `${tabId}:${requestId}`;
      const hybridPacket = videoRequest && message.planning !== undefined && resourceFromUrl(sender.url ?? '')?.platform === 'bilibili'
        && hybridEnabled((await config()).settings);
      const videoPacketLimit = hybridPacket ? 64 : engine.hasLiveWork() ? 18 : 20;
      let admissionController: AbortController | undefined;
      if (repairRequest || videoRequest) {
        if (running.has(key)) return { ok: false, error: '重复请求' };
        if (running.size >= 1024 || (videoRequest && running.size - liveRunning.size >= videoPacketLimit)) return { ok: false, error: '准备队列繁忙，稍后继续', retryAfterMs: 1000 };
        admissionController = new AbortController(); running.set(key, admissionController);
        if (repairRequest) liveRunning.add(key);
      }
      const admissionCurrent = () => !admissionController || !admissionController.signal.aborted && running.get(key) === admissionController;
      try {
      const resource = await currentResource(tabId), resourceId = resource?.resourceId;
      if (!resource || resourceId !== message.resourceId) return videoChanging();
      const live = resource.scenario === 'live';
      const sessionBound = live || resource.platform === 'bilibili';
      if (live && (!liveSessionMatches(tabId, sender, message.session) || !Number.isFinite(message.sentAt))) return videoChanging();
      if (sessionBound && !liveSessionMatches(tabId, sender, message.session)) return videoChanging();
      if (new URL(sender.url!).origin !== resourceOrigin(resource)) return videoChanging();
      const liveSession = sessionBound ? tabs.get(tabId)!.session : undefined;
      const pinnedRepair = repairPurpose === 'pinned';
      if (repairPurpose !== undefined && !['manual', 'superchat', 'pinned', 'timeout'].includes(repairPurpose)) return { ok: false, error: '无效补翻请求' };
      if (repairPurpose !== undefined && (!live || !['youtube','bilibili','niconico'].includes(resource.platform) || resource.platform === 'niconico' && repairPurpose !== 'timeout')) return { ok: false, error: '无效补翻请求' };
      if (repairPurpose === 'pinned' && resource.platform !== 'youtube') return { ok: false, error: '无效补翻请求' };
      if (repairPurpose === 'pinned' && (message.forceTranslate !== false || message.force !== false)) return { ok: false, error: '无效补翻请求' };
      if (repairPurpose === 'manual' && (message.forceTranslate !== true || typeof message.force !== 'boolean')) return { ok: false, error: '无效补翻请求' };
      if (repairPurpose === 'superchat' && (typeof message.forceTranslate !== 'boolean' || typeof message.force !== 'boolean' || message.force && !message.forceTranslate)) return { ok: false, error: '无效补翻请求' };
      if (repairPurpose === 'timeout' && (message.forceTranslate !== false || message.force !== false)) return { ok: false, error: '无效补翻请求' };
      if (typeof message.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(message.requestId) || !Array.isArray(message.items) || !message.items.length || message.items.length > 200) return { ok: false, error: '无效批次' };
      const planned = message.planning !== undefined;
      // Owned MAIN deadlines and watch sentAt use wall time. Convert them once
      // to the engine's monotonic clock without mixing in performance.timeOrigin.
      const plannedDue = planned ? plannedDueItems(message, liveSession, receivedWallAt, receivedNow, requestVersion) : null;
      if (planned && (!videoRequest || live || !plannedDue)) return { ok: false, error: '无效计划批次' };
        const configured = await config();
        const settings = live ? { ...configured.settings, sourceLanguage: configured.settings.liveSourceLanguage }
          : { ...configured.settings, batchSize: videoBatchLimit(configured.settings) };
        const apiKey = configured.apiKey;
        if (!settings.enabled || settings.displayMode === 'original') return { ok: false, error: '翻译已关闭' };
        if (planned && configured.settings.bilibiliOwnedRelease !== true)
          return { ok: false, error: '提前翻译未启用' };
        const allPlannedExpired = () => planned && message.items.every((item: any) =>
          plannedDue!.get(item.id)!.deadlineAt <= performance.now());
        const expiredPlannedReply = () => ({ ok: true, items: message.items.map((item: any) =>
          ({ id: item.id, text: item.text, status: 'expired', reason: 'deadline' })) });
        if (allPlannedExpired()) return expiredPlannedReply();
        const timeoutPolicy = getTimeoutRetryPolicy(settings, resource.platform);
        if (repairPurpose === 'timeout' && !timeoutPolicy) return { ok: false, error: '超时自动补翻已关闭' };
        const hybrid = planned && resource.platform === 'bilibili' && hybridEnabled(settings)
          ? await hybridRoute(configured.settings, apiKey, requestVersion) : undefined;
        if (hybrid && 'error' in hybrid) return { ok: false, error: hybrid.error };
        const setupError = hybrid || settings.backend === 'local' ? undefined : onlineSetupError(settings);
        if (setupError) return { ok: false, error: setupError };
        if (!hybrid && !apiKey && settings.backend !== 'local') return { ok: false, error: '请先配置 API Key' };
        if (!hybrid && credentialRejected && settings.backend !== 'local') return { ok: false, error: '服务拒绝凭据，请检查设置并保存后重试' };
        const origin = configuredOrigin(settings);
        if (!hybrid && settings.backend !== 'local' && origin && !await browser.permissions.contains({ origins: [origin + '/*'] })) return { ok: false, error: '请在设置中授权翻译服务地址' };
        if (!hybrid && settings.backend === 'local') {
          if (allPlannedExpired()) return expiredPlannedReply();
          try { const local = await readyLocal(settings, false); Object.assign(settings, withLocalRuntime(settings, local)); }
          catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'LOCAL_LOAD_FAILED' }; }
          const languageIssue = translationLanguageIssue(settings.localTranslationProfile, settings.sourceLanguage, settings.targetLanguage);
          if (languageIssue) return { ok: false, error: translationLanguageMessage(languageIssue) ?? languageIssue };
        }
      const seen = new Set<string>(); const items: TranslationInput[] = [];
      const emotePlans = new Map<string, { original: string; plan: NonNullable<ReturnType<typeof prepareEmoteText>> }>();
      let chars = 0;
      for (const item of message.items) {
        if (typeof item?.id !== 'string' || !item.id || item.id.length > 400 || seen.has(item.id) ||
            typeof item.text !== 'string' || !item.text || item.text.length > 1000 ||
            typeof item.remainingMs !== 'number' || !Number.isFinite(item.remainingMs) || item.remainingMs <= 0) return { ok: false, error: '无效消息条目' };
        if ((repairPurpose === 'pinned' && item.strategy !== 'manual') || (repairPurpose === 'manual' && !['manual', 'superchat'].includes(item.strategy)) ||
            repairPurpose === 'superchat' && item.strategy !== 'superchat' || repairPurpose === 'timeout' && item.strategy !== 'normal') return { ok: false, error: '无效补翻请求' };
        let sourceText = item.text;
        if (item.emoteTokens !== undefined) {
          const plan = resource.platform === 'bilibili' && live ? prepareEmoteText(item.text, item.emoteTokens) : null;
          if (!plan?.hasProse) return { ok: false, error: '无效图文弹幕' };
          emotePlans.set(item.id, { original: item.text, plan }); sourceText = plan.text;
        }
        seen.add(item.id); chars += sourceText.length;
        const strategy = item.strategy === 'superchat' ? 'superchat' : item.strategy === 'manual' && (message.forceTranslate === true || pinnedRepair) ? 'manual' : 'normal';
        const budget = repairPurpose === 'timeout' ? timeoutPolicy!.timeoutMs
          : strategy === 'superchat' ? settings.superChatTimeoutMs ?? 15000 : strategy === 'manual' ? 15000 : settings.liveBufferMs;
        items.push({ id: item.id, text: sourceText, strategy, deadlineAt: planned ? plannedDue!.get(item.id)!.deadlineAt : live
          ? localDeadline(item.remainingMs, message.sentAt, receivedAt, receivedNow, budget)
          : performance.now() + Math.min(providerTimeoutMs(settings), item.remainingMs) });
      }
      if (chars > (live ? 24000 : settings.maxBatchChars) || items.length > (live || hybrid ? 200 : settings.batchSize)) return { ok: false, error: '批次超过配置限制' };
      // Configuration and permission reads can span a navigation; recheck before admission.
      if (!sameResource(await currentResource(tabId), resource) || (sessionBound && tabs.get(tabId)?.session !== liveSession)) return videoChanging();
      if (testPause || !admissionCurrent()) return { ok: false, error: testPause ? '性能测试中，翻译暂时暂停' : '请求已取消' };
      // IPC envelopes are independent of the API pool. Keep VOD's old 20/18 bound and room for live's 64 API slots.
      if (running.size - (admissionController ? 1 : 0) >= 1024 || (!live && running.size - liveRunning.size - (admissionController ? 1 : 0) >= videoPacketLimit)) return { ok: false, error: '准备队列繁忙，稍后继续', retryAfterMs: 1000 };
      if (!admissionController && running.has(key)) return { ok: false, error: '重复请求' };
      if (requestVersion !== version || (message.configVersion !== undefined && message.configVersion !== requestVersion)) return { ok: false, error: '配置已变化' };
      const controller = admissionController ?? new AbortController(); const capturedVersion = requestVersion;
      if (!admissionController) { running.set(key, controller); if (live) liveRunning.add(key); }
      try {
        const restoreOutput = (output: TranslationOutput): TranslationOutput => {
          const value = emotePlans.get(output.id); if (!value) return output;
          if (!['translated', 'cached'].includes(output.status)) return { ...output, text: value.original };
          const text = typeof output.text === 'string' ? value.plan.restore(output.text) : undefined;
          return text === undefined ? { id: output.id, text: value.original, status: 'failed', reason: 'invalid-inline-emotes' } : { ...output, text };
        };
        const priority = ['near', 'buffered', 'background'].includes(message.priority) ? message.priority : 'background';
        const onResult = (output: TranslationOutput) => {
          output = restoreOutput(output);
          if (capturedVersion !== version || controller.signal.aborted || running.get(key) !== controller || (sessionBound && tabs.get(tabId)?.session !== liveSession) ||
              revokedVideoItems.get(controller)?.has(output.id) || !seen.has(output.id) || (output.status !== 'translated' && output.status !== 'cached') || typeof output.text !== 'string' || !output.text.trim() || output.text.length > 2000) return;
          const due = plannedDue?.get(output.id);
          if (planned && (!due || performance.now() >= due.deadlineAt ||
              output.text === message.items.find((item: any) => item.id === output.id)?.text)) return;
          // Do not wait for sibling results or accounting. The receiving document checks its own current session and deadline.
          const resultMessage = { type: live ? 'live-translation-result' : 'video-translation-result', requestId: message.requestId,
            resourceId, session: liveSession, configVersion: capturedVersion, output: { id: output.id, text: output.text, status: output.status,
              ...(output.backend ? { backend: output.backend } : {}) } };
          const send = async () => {
            if (planned && (!sameResource(await currentResource(tabId), resource) ||
                tabs.get(tabId)?.session !== liveSession || capturedVersion !== version ||
                controller.signal.aborted || revokedVideoItems.get(controller)?.has(output.id) ||
                performance.now() >= due!.deadlineAt)) return;
            await browser.tabs.sendMessage(tabId, planned ? { ...resultMessage,
              planning: { epoch: due!.epoch, configIdentity: message.planning.configIdentity },
              output: { ...resultMessage.output, sourceId: due!.sourceId, epoch: due!.epoch,
                predictionEpoch: due!.predictionEpoch, ruleRevision: due!.ruleRevision,
                deadlineAtEpochMs: due!.deadlineAtEpochMs } } : resultMessage,
            sender.documentId ? { documentId: sender.documentId, frameId: 0 } : { frameId: 0 });
          };
          void send().catch(() => {});
        };
        const responses = await Promise.all((['normal', 'superchat', 'manual'] as const).map(async strategy => {
          const selected = items.filter(item => (item.strategy ?? 'normal') === strategy && !revokedVideoItems.get(controller)?.has(item.id));
          if (!selected.length) return { items: [], usage: undefined };
          return engine.translate({ resourceId: cacheResource(resource), settings: strategySettings(settings, pinnedRepair && strategy === 'manual' ? 'normal' : strategy), apiKey, items: selected, signal: controller.signal,
            ...(hybrid ? { hybrid, settings: hybrid.local } : {}),
            mode: live ? 'deadline' : planned ? undefined : 'vod', priority, quotaScope: `tab:${tabId}`, onResult,
            forceTranslate: message.forceTranslate === true, force: message.force === true && message.forceTranslate === true });
        }));
        const byId = new Map(responses.flatMap(response => response.items).map(item => [item.id, restoreOutput(item)]));
        const response = { items: items.map(item => byId.get(item.id)).filter((item): item is TranslationOutput => item !== undefined), usage: responses.reduce((usage, row) => addUsage(usage, row.usage), undefined as import('../src/core/types').Usage | undefined) };
        const activeResource = await currentResource(tabId);
        if (capturedVersion !== version || controller.signal.aborted) return { ok: false, error: '配置或播放位置已变化' };
      if (!sameResource(activeResource, resource) || (sessionBound && tabs.get(tabId)?.session !== liveSession)) return videoChanging();
        if (response.items.some(item => (item.reason === 'http-401' || item.reason === 'http-403') &&
            (hybrid ? item.backend === 'online' : settings.backend !== 'local'))) credentialRejected = true;
        return { ok: true, ...response, ...(hybrid ? { hybridStats: engine.stats().hybrid } : {}) };
      } finally { if (running.get(key) === controller) { running.delete(key); liveRunning.delete(key); } }
      } finally { if (admissionController && running.get(key) === admissionController) { running.delete(key); liveRunning.delete(key); } }
    }
    // A current Bilibili player can change the translation switch, never provider settings or credentials.
    if (message.type === 'video-translation-toggle' && tabId !== null) {
      if (typeof message.enabled !== 'boolean') return { ok: false, error: '无效设置' };
      const matches = async () => liveSessionMatches(tabId, sender, message.session) &&
        message.session.platform === 'bilibili' && message.session.scenario === 'video' &&
        sameResource(await currentResource(tabId), message.session);
      if (!await matches()) return videoChanging();
      let rejected: string | undefined;
      let changedPage = false;
      await updateSettings(async latest => {
        if (!await matches()) { changedPage = true; return latest; }
        if (!latest.enabled && message.enabled && latest.backend !== 'local') {
          rejected = onlineSetupError(latest);
          if (rejected) return latest;
        }
        if (!latest.enabled && message.enabled) await localLoader.setPaused(false);
        if (!await matches()) { changedPage = true; return latest; }
        cancelAll(false);
        return { ...latest, enabled: message.enabled };
      });
      if (changedPage) return videoChanging();
      if (rejected) return { ok: false, error: rejected };
      await broadcast(); void prepareLocal(); return safeConfig();
    }
    // The page-side range control cannot change provider configuration or credentials.
    if (message.type === 'scheduling-settings' && tabId !== null) {
      const resourceId = await currentVideo(tabId);
      if (!resourceId || resourceId !== message.resourceId) return videoChanging();
      if ((await currentResource(tabId))?.platform === 'bilibili' && !liveSessionMatches(tabId, sender, message.session)) return videoChanging();
      if (!['auto', 'all', 'window'].includes(message.translationScope) || !Number.isInteger(message.prefetchSeconds) || message.prefetchSeconds < 5 || message.prefetchSeconds > 3600) return { ok: false, error: '请输入 5–3600 秒' };
      const { settings } = await config();
      const updated = normalizeSettings({ ...settings, translationScope: message.translationScope, prefetchSeconds: message.prefetchSeconds }, { stored: true });
      if (await currentVideo(tabId) !== resourceId) return videoChanging();
      await updateSettings(latest => ({ ...latest, translationScope: updated.translationScope, prefetchSeconds: updated.prefetchSeconds })); await broadcast(); return safeConfig();
    }
    if (!ui) return { ok: false, error: '此操作仅限扩展设置页' };
    if (message.type === 'hybrid-capacity') {
      const draft = normalizeSettings(message.settings, { stored: true });
      const identity = await hybridCapacityIdentity(draft);
      return { ok: true, identity, profile: draft.bilibiliHybrid?.profiles.find(profile => profile.identity === identity),
        recommendation: recommendHybridCapacity(await performanceHistory.list(), identity) };
    }
    if (message.type === 'online-budget-status') {
      const { settings } = await config();
      return { ok: true, onlineBudget: await onlineBudget.read(settings.onlineRequestLimitPerDay) };
    }
    if (message.type === 'open-model-folders') {
      if (message.directoryId !== undefined && (typeof message.directoryId !== 'string' || message.directoryId.length > 200)) return { ok: false, error: '无效文件夹' };
      if (message.modelId !== undefined && (typeof message.modelId !== 'string' || !message.modelId || message.modelId.length > 200)) return { ok: false, error: '无效模型' };
      const hash = message.modelId ? '#file:' + encodeURIComponent(message.modelId) : message.directoryId ? '#' + encodeURIComponent(message.directoryId) : message.files ? '#files' : '';
      await browser.windows.create({ url: browser.runtime.getURL('/model-folders.html') + hash, type: 'popup', width: 660, height: 520 });
      return { ok: true };
    }
    if (message.type === 'service-history') return { ok: true, addresses: await serviceHistory.read() };
    if (message.type === 'open-settings') {
      if (!trustedUi(sender) || new URL(sender.url!).pathname !== '/popup.html') return { ok: false, error: '请从插件按钮打开页内设置。' };
      await browser.runtime.openOptionsPage();
      return { ok: true, mode: 'standalone' };
    }
    if (message.type === 'select-local-model') {
      if (typeof message.modelId !== 'string' || message.modelId.length > 200) return { ok: false, error: '请选择可用的本地模型' };
      if (localChoiceLoading) return { ok: false, error: '本地模型正在使用中，请结束当前翻译或测试后再试' };
      if (message.load === true) {
        if (!message.modelId) return { ok: false, error: '请选择可用的本地模型' };
        let requestedConfig;
        try { requestedConfig = normalizeLocalConfig(message.config); }
        catch { return { ok: false, error: 'LOCAL_CONFIG_INVALID' }; }
        if (testPause) return { ok: false, error: '性能测试正在使用模型，请先停止测试' };
        let saved: Settings | undefined;
        let committed = false;
        let loadReply: any;
        localChoiceLoading = true;
        try {
          const policyRevision = await serializeSettingsWrite(async () => {
            if (testPause) throw new Error('性能测试正在使用模型，请先停止测试');
            const latest = (await config()).settings;
            // Selection validation shares the settings queue with deletion and reconciliation.
            const listed = await localControl({ action: 'list' });
            if (!listed.ok || !listed.models?.some(model => model.id === message.modelId && (!model.availability || model.availability === 'ready'))) throw new Error('LOCAL_MODEL_NOT_IMPORTED');
            if (['loading', 'warming', 'generating'].includes(listed.state?.phase ?? '')) throw new Error('本地模型正在使用中，请结束当前翻译或测试后再试');
            if (testPause) throw new Error('性能测试正在使用模型，请先停止测试');
            cancelAll();
            saved = { ...latest, localModelId: message.modelId };
            await browser.storage.local.set({ [SETTINGS_KEY]: saved });
            committed = true;
            return localLoader.setPaused(false);
          });
          // A failed source read asks the background to reconcile through this same
          // settings queue. Release it before awaiting load to avoid a reverse-IPC deadlock.
          const releaseLoad = keepAlive();
          try {
            loadReply = await localControl({ action: 'load', modelId: message.modelId, config: requestedConfig, policyRevision } as any);
            await localLoader.observe(loadReply.state);
          } finally { releaseLoad(); }
          await broadcast(true);
          let state = loadReply?.state;
          if (!state) {
            try { state = (await localControl({ action: 'state' })).state; } catch { /* Preserve the load result. */ }
          }
          await localLoader.retainExplicitLoad(saved!, state);
          return { ...(loadReply ?? { ok: false, error: 'LOCAL_LOAD_FAILED' }), settings: (await config()).settings,
            localRuntime: await localLoader.status(), state: state ?? null };
        } catch (error) {
          if (!committed) return { ok: false, error: error instanceof Error ? error.message : 'LOCAL_MODEL_NOT_IMPORTED' };
          let state = loadReply?.state;
          if (!state) {
            try { state = (await localControl({ action: 'state' })).state; } catch { /* State can be refreshed on the next request. */ }
          }
          await localLoader.retainExplicitLoad(saved!, state);
          await broadcast(true);
          return { ok: false, error: error instanceof Error ? error.message : 'LOCAL_LOAD_FAILED',
            settings: (await config()).settings, localRuntime: await localLoader.status(), state: state ?? null };
        } finally { localChoiceLoading = false; }
      }
      await updateSettings(async latest => {
        // Validate inside the same write queue as deletion: an earlier list can become stale.
        const listed = await localControl({ action: 'list' });
        if (!listed.ok || message.modelId && !listed.models?.some(model => model.id === message.modelId && (!model.availability || model.availability === 'ready'))) throw new Error('LOCAL_MODEL_NOT_IMPORTED');
        if (latest.localModelId !== message.modelId) cancelAll();
        if (message.modelId) await localLoader.setPaused(false);
        if (!message.modelId) {
          const revision = await localLoader.setPaused(true);
          const stopped = await localControl({ action: 'unload', policyRevision: revision } as any); await localLoader.observe(stopped.state);
        }
        return { ...latest, localModelId: message.modelId };
      });
      await broadcast(true); void prepareLocal(); return safeConfig();
    }
    if (message.type === 'local-control') {
      if (!['state', 'list', 'load', 'cancel', 'unload', 'delete', 'files-changed', 'benchmark-start', 'benchmark-status', 'benchmark-stop', 'directory-status', 'directory-scan', 'directory-cancel', 'directory-remove'].includes(message.control?.action)) return { ok: false, error: '无效本地模型操作' };
      const action = message.control.action;
      if (action === 'load' && localChoiceLoading) return { ok: false, error: '本地模型正在使用中，请结束当前翻译或测试后再试', localRuntime: await localLoader.status() };
      if (localChoiceLoading && ['delete', 'files-changed', 'directory-scan', 'directory-remove'].includes(action)) return { ok: false, error: '本地模型正在使用中，请结束当前翻译或测试后再试', localRuntime: await localLoader.status() };
      if (action === 'benchmark-start' && localChoiceLoading) return { ok: false, error: '本地模型正在使用中，请结束当前翻译或测试后再试', localRuntime: await localLoader.status() };
      if (action.startsWith('directory-')) {
        const id = message.control.directoryId;
        if (id !== undefined && (typeof id !== 'string' || !id || id.length > 200) || action === 'directory-remove' && !id) return { ok: false, error: '无效文件夹' };
        if (testPause && ['directory-scan', 'directory-remove'].includes(action)) return { ok: false, error: '性能测试中，请稍后刷新或移除文件夹' };
        const release = action === 'directory-scan' ? keepAlive() : () => {};
        try {
          const reply = await localControl(message.control);
          return { ...reply, settings: (await config()).settings, localRuntime: await localLoader.status() };
        } finally { release(); }
      }
      if (action === 'delete') {
        const modelId = message.control.modelId;
        if (typeof modelId !== 'string' || !modelId || modelId.length > 200) return { ok: false, error: '请选择要删除的模型' };
        const release = keepAlive();
        try {
          let deleted: Awaited<ReturnType<typeof localControl>> | undefined;
          const saved = await updateSettings(async latest => {
            if (testPause) throw new Error('性能测试中，暂不能删除模型');
            const listed = await localControl({ action: 'list' });
            if (!listed.ok) throw new Error(listed.error ?? 'LOCAL_STORAGE_UNAVAILABLE');
            const selectedModel = listed.models?.find(model => model.id === modelId);
            if (!selectedModel) throw new Error('LOCAL_MODEL_NOT_IMPORTED');
            if (testPause) throw new Error('性能测试中，暂不能删除模型');
            const affectsLocal = latest.localModelId === modelId || listed.state?.model?.id === modelId;
            const policyRevision = affectsLocal ? await localLoader.setPaused(true) : undefined;
            if (affectsLocal && latest.backend === 'local') cancelAll(false);
            const deletion = { action: 'delete' as const, modelId, policyRevision };
            deleted = await localControl(deletion);
            await localLoader.observe(deleted.state);
            if (!deleted.ok) throw new Error(deleted.error ?? 'LOCAL_STORAGE_QUOTA_OR_IO');
            // Deletion, like import, only commits the model choice; never a UI draft.
            return latest.localModelId === modelId ? { ...latest, localModelId: '' } : latest;
          });
          await broadcast(true);
          return { ...deleted, settings: saved, localRuntime: await localLoader.status() };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : '删除失败，请重试', localRuntime: await localLoader.status() };
        } finally { release(); }
      }
      if (action === 'benchmark-start') {
        let lease: TestLease | undefined, dispatched = false;
        try {
          lease = await acquireTest('local-benchmark');
          await drainTranslations(lease, true);
          if (lease.cancelled) throw new Error('测试已取消');
          dispatched = true;
          let reply = await localControl(message.control);
          if (!reply.ok || !reply.report) { await releaseTest(lease); return reply; }
          lease.benchmarkId = reply.report.id;
          if (lease.cancelled) reply = await localControl({ action: 'benchmark-stop' });
          await finishLocalBenchmark();
          return reply;
        } catch (error) {
          if (lease) {
            // A lost start reply is not proof the offscreen operation never began.
            const state = dispatched ? await localControl({ action: 'benchmark-status' }).catch(() => undefined) : undefined;
            if (state?.report && ['running','stopping'].includes(state.report.status)) {
              lease.benchmarkId = state.report.id;
              if (lease.cancelled) await localControl({ action: 'benchmark-stop' }).then(() => finishLocalBenchmark()).catch(() => {});
            } else await releaseTest(lease);
          }
          return { ok: false, error: error instanceof Error ? error.message : '性能测试未能启动' };
        }
      }
      if (action === 'benchmark-stop' && testPause?.kind === 'local-benchmark' && !testPause.benchmarkId) {
        testPause.cancelled = true; return { ok: true, report: null };
      }
      if (testPause && ['load','cancel','unload'].includes(action)) return { ok: false, error: '性能测试正在使用模型，请先停止测试' };
      if (['load','cancel','unload'].includes(action)) cancelAll();
      const policyRevision = action === 'load' ? await localLoader.setPaused(false)
        : ['cancel', 'unload'].includes(action) ? await localLoader.setPaused(true) : undefined;
      const release = message.control.action === 'load' ? keepAlive() : () => {};
      try {
        const reply = await localControl({ ...message.control, policyRevision });
        await localLoader.observe(reply.state);
        if (['benchmark-status','benchmark-stop'].includes(action)) await finishLocalBenchmark();
        return { ...reply, localRuntime: await localLoader.status() };
      } finally { release(); if (['load','cancel','unload'].includes(action)) await broadcast(true); }
    }
    if (message.type === 'performance-status') {
      if (performanceTest?.report.state === 'running' && localPerformanceBaseline?.id === performanceTest.report.id) {
        const local = await localControl({ action: 'state' }).catch(() => null);
        performanceTest.report.localInferenceCalls = local?.state?.generation === localPerformanceBaseline.generation ? local.state.inferenceCalls - localPerformanceBaseline.calls : null;
      }
      return { ok: true, report: performanceTest?.snapshot() ?? null, saveState: performanceSaveState, batch: batchStatus() };
    }
    if (message.type === 'performance-history') {
      try { return { ok: true, records: await performanceHistory.list() }; }
      catch { return { ok: false }; }
    }
    if (message.type === 'performance-history-save') {
      if (!performanceTest || performanceTest.report.state === 'running' || performanceSaveState === 'pending' ||
          deletedPerformanceIds.has(performanceTest.report.id)) return { ok: false };
      await savePerformance(performanceTest);
      return { ok: performanceSaveState === 'saved' };
    }
    if (message.type === 'performance-history-delete') {
      if (!trustedUi(sender) || !Array.isArray(message.ids) || !message.ids.length || message.ids.length > 50 ||
          message.ids.some((id: unknown) => typeof id !== 'string' || !id || id.length > 128 || /[\\\u0000-\u001f\u007f]/.test(id))) return { ok: false };
      const ids: string[] = message.ids;
      if (performanceTest?.report.state === 'running' && ids.includes(performanceTest.report.id)) return { ok: false };
      const protectedIds = ids.filter(id => performanceTest?.report.id === id || batchReportIds.has(id));
      const added = protectedIds.filter(id => !deletedPerformanceIds.has(id));
      protectedIds.forEach(rememberDeleted);
      try {
        // History serializes this after any auto-save already in progress.
        await performanceHistory.delete(ids);
        if (performanceTest && ids.includes(performanceTest.report.id)) performanceSaveState = 'deleted';
        return { ok: true };
      } catch {
        added.forEach(id => deletedPerformanceIds.delete(id));
        return { ok: false };
      }
    }
    if (message.type === 'performance-stop') {
      if (performanceBatch?.state === 'running') {
        cancelPerformanceBatch('PERFORMANCE_BATCH_STOPPED');
        return { ok: true, report: performanceTest?.snapshot() ?? null, batch: batchStatus() };
      }
      if (testPause?.kind === 'performance') testPause.cancelled = true;
      performanceTest?.stop(); return { ok: true, report: performanceTest?.snapshot() ?? null };
    }
    if (message.type === 'performance-start') {
      if (localChoiceLoading) return { ok: false, error: '本地模型正在使用中，请结束当前翻译或测试后再试' };
      if (performanceBatch?.state === 'running' || testPause || performanceTest?.report.state === 'running' || modelTest) return { ok: false, error: '已有测试正在运行' };
      const settings = await normalizeSubmittedSettings(message.settings, message.apiKey);
      if (message.modelIds !== undefined) {
        const ids: unknown = message.modelIds;
        if (settings.backend !== 'local' || !Array.isArray(ids) || ids.length < 1 || ids.length > 20 ||
            ids.some(id => typeof id !== 'string' || !id || id.length > 200) || new Set(ids).size !== ids.length)
          return { ok: false, error: 'PERFORMANCE_BATCH_INVALID_MODELS' };
        let config;
        try { config = validatePerformanceConfig(message.config); }
        catch { return { ok: false, error: 'invalid-performance-config' }; }
        const batch: PerformanceBatch = { id: crypto.randomUUID(), modelIds: [...ids], index: 0, total: ids.length, completed: 0,
          phase: 'preparing', state: 'running', cancelled: false };
        batchReportIds.clear();
        performanceBatch = batch; performanceTest = undefined; localPerformanceBaseline = undefined; performanceSaveState = null;
        void runPerformanceBatch(batch, settings, config);
        return { ok: true, report: null, batch: batchStatus() };
      }
      performanceBatch = undefined;
      const existing = await config();
      const setupError = settings.backend === 'local' ? undefined : onlineSetupError(settings);
      if (setupError) return { ok: false, error: setupError };
      const origin = configuredOrigin(settings);
      if (settings.backend !== 'local' && origin && !await browser.permissions.contains({ origins: [origin + '/*'] })) return { ok: false, error: '请先授权该服务地址' };
      if (message.apiKey !== undefined && (typeof message.apiKey !== 'string' || message.apiKey.length > 4096 || /[\r\n]/.test(message.apiKey))) return { ok: false, error: 'API Key 格式无效' };
      const key = message.apiKey || (origin && configuredOrigin(existing.settings) === origin ? existing.apiKey : '');
      if (!key && settings.backend !== 'local') return { ok: false, error: '请为此服务填写 API Key' };
      // Constructor validates the replay before pausing any viewing session.
      let lease: TestLease | undefined;
      try {
        let run = new PerformanceTest(message.config, settings, settings.backend === 'local' ? 'local-inference' : key, providerOptions(settings));
        const capacityIdentity = settings.backend === 'local' ? await hybridCapacityIdentity({ ...settings,
          sourceLanguage: settings.liveSourceLanguage, localConcurrency: message.config.concurrency }) : undefined;
        lease = await acquireTest('performance');
        const native = settings.backend === 'local' || existing.settings.backend === 'local';
        await drainTranslations(lease, native);
        let localState;
        if (settings.backend === 'local') {
          localState = await readyLocal(settings);
          Object.assign(settings, withLocalRuntime(settings, localState));
          run = new PerformanceTest(message.config, settings, 'local-inference', providerOptions(settings));
          if (localState.model) run.report.model = localState.model.name;
        }
        if (lease.cancelled) throw new Error('测试已取消');
        performanceTest = run;
        performanceSaveState = 'pending';
        run.report.measurement.extensionVersion = browser.runtime.getManifest().version;
        if (capacityIdentity) run.report.measurement.capacityIdentity = capacityIdentity;
        if (localState?.runtime) run.report.measurement.localRuntime = structuredClone(localState.runtime);
        localPerformanceBaseline = localState ? { id: run.report.id, generation: localState.generation, calls: localState.inferenceCalls } : undefined;
        const owned = lease;
        void run.run().catch(() => run.stop('测试执行失败')).finally(async () => {
          try {
            // Provider cancellation can complete before native cooperative abort has settled.
            owned.cancelled = false;
            await drainTranslations(owned, native);
          } catch {
            if (settings.backend === 'local') await localControl({ action: 'cancel' }).then(reply => localLoader.observe(reply.state)).catch(() => {});
          } finally {
            try {
              if (localPerformanceBaseline?.id === run.report.id) {
                const local = await localControl({ action: 'state' }).catch(() => null);
                run.report.localInferenceCalls = local?.state?.generation === localPerformanceBaseline.generation
                  ? local.state.inferenceCalls - localPerformanceBaseline.calls : null;
              }
              await savePerformance(run);
            } finally { await releaseTest(owned); }
          }
        });
        return { ok: true, report: run.snapshot() };
      } catch (error) {
        if (lease) await releaseTest(lease);
        const code = error instanceof Error ? error.message : '性能测试未能启动';
        return { ok: false, error: translationLanguageMessage(code) ?? code };
      }
    }
    if (message.type === 'live-diagnostics') {
      const latest = [...tabs.entries()].filter(([,value])=>value.status?.scenario==='live').sort((a,b)=>b[1].lastSeen-a[1].lastSeen);
      let status: RuntimeStatus | null = null;
      for (const [id,value] of latest) {
        if(Date.now()-value.lastSeen>120000)continue;
        const current=await currentResource(id);
        if(current?.scenario==='live'&&current.resourceId===value.status?.resourceId&&current.platform===value.status?.platform) { status=value.status!;break; }
      }
      return {ok:true,status,engine:engine.stats()};
    }
    if (message.type === 'model-catalog') {
      const settings = normalizeSettings({ ...message.settings, thinkingEffort: undefined, superChatThinkingEffort: 'inherit' }), existing = await config();
      if (settings.backend === 'local') return { ok: true };
      const origin = configuredOrigin(settings);
      if (!origin) return { ok: false, error: '请先填写服务地址' };
      if (message.apiKey !== undefined && (typeof message.apiKey !== 'string' || message.apiKey.length > 4096 || /[\r\n]/.test(message.apiKey))) return { ok: false, error: 'API Key 格式无效' };
      const key = message.apiKey || (configuredOrigin(existing.settings) === origin ? existing.apiKey : '');
      return { ok: true, catalog: key ? await catalogs.read(await modelCatalogScope(settings, key)) : undefined };
    }
    if (message.type === 'models') {
      if (modelLookup) return { ok: false, error: '正在获取模型，请稍候' };
      const controller = new AbortController(); modelLookup = controller;
      const capturedVersion = version;
      try {
        const settings = normalizeSettings({ ...message.settings, thinkingEffort: undefined, superChatThinkingEffort: 'inherit' });
        if (settings.backend === 'local') { const local = await localControl({ action: 'list' }); return { ok: local.ok, models: local.models?.map(model => model.name) ?? [] }; }
        const origin = configuredOrigin(settings);
        if (!origin) return { ok: false, error: '请先填写服务地址' };
        if (!await browser.permissions.contains({ origins: [origin + '/*'] })) return { ok: false, error: '请先授权该服务地址' };
        if (message.apiKey !== undefined && (typeof message.apiKey !== 'string' || message.apiKey.length > 4096 || /[\r\n]/.test(message.apiKey))) return { ok: false, error: 'API Key 格式无效' };
        const existing = await config();
        const key = message.apiKey || (configuredOrigin(existing.settings) === origin ? existing.apiKey : '');
        if (!key) return { ok: false, error: '请为此服务填写 API Key' };
        if (controller.signal.aborted || capturedVersion !== version) return { ok: false, error: '配置已变化，请重新获取模型' };
        const discovered = await discoverConnectionModels(settings, key, { signal: controller.signal });
        if (capturedVersion !== version) return { ok: false, error: '配置已变化，请重新获取模型' };
        const fetchedAt = Date.now();
        await catalogs.write(await modelCatalogScope(settings, key), discovered.models, fetchedAt, discovered.capabilities);
        if (discovered.effectiveEndpoint) await catalogs.write(await modelCatalogScope({ ...settings, endpoint: discovered.effectiveEndpoint, endpointMode: discovered.effectiveEndpointMode }, key), discovered.models, fetchedAt, discovered.capabilities);
        await serviceHistory.record(discovered.effectiveEndpoint ? { ...settings, endpoint: discovered.effectiveEndpoint, endpointMode: discovered.effectiveEndpointMode } : settings).catch(() => {});
        return { ok: true, ...discovered, fetchedAt };
      } catch (error) {
        const code = error instanceof ProviderError ? error.message : 'invalid-config';
        const errors: Record<string, string> = {
          'network-error': '无法连接模型接口，请检查服务地址和网络', timeout: '获取模型超时，请检查服务是否可达',
          'http-401': '服务拒绝 Key，请检查凭据', 'http-403': '服务拒绝访问，请检查凭据与访问范围',
          'http-404': '服务未提供此模型列表接口；仍可手动填写模型', 'http-429': '模型查询被限流，请稍后重试',
          'empty-model-list': '服务未返回可用模型，请检查 Key 的模型范围', 'invalid-response': '模型列表格式不兼容；可手动填写模型',
          'models-endpoint-ambiguous': '完整接口无法推导模型列表地址；可手动填写模型并单独测试翻译',
          cancelled: '查询已取消，请重新获取模型', 'invalid-config': '请检查服务地址和 HTTP 选项',
        };
        return { ok: false, error: errors[code] ?? '模型查询失败；请检查服务状态或手动填写模型' };
      } finally { if (modelLookup === controller) modelLookup = undefined; }
    }
    if (message.type === 'test-model') {
      if (testPause || performanceTest?.report.state === 'running') return { ok: false, error: '性能测试正在运行' };
      if (modelTest) return { ok: false, error: '正在测试模型，请稍候' };
      if (localChoiceLoading) return { ok: false, error: '本地模型正在使用中，请结束当前翻译或测试后再试' };
      const controller = new AbortController(); modelTest = controller;
      const capturedVersion = version;
      let timeoutMs = 0;
      try {
        const settings = await normalizeSubmittedSettings(message.settings, message.apiKey);
        if (settings.backend === 'local') {
          if (!settings.localModelId) return { ok: false, error: '请选择可用的本地模型' };
        } else {
          const setupError = onlineSetupError(settings);
          if (setupError) return { ok: false, error: setupError };
        }
        const localState = settings.backend === 'local' ? await readyLocal(settings) : undefined;
        if (localState) Object.assign(settings, withLocalRuntime(settings, localState));
        if (settings.backend === 'local' && message.context !== 'video') settings.sourceLanguage = settings.liveSourceLanguage;
        const origin = configuredOrigin(settings);
        timeoutMs = providerTimeoutMs(settings);
        if (settings.backend !== 'local' && origin && !await browser.permissions.contains({ origins: [origin + '/*'] })) return { ok: false, error: '请先授权该服务地址' };
        if (message.apiKey !== undefined && (typeof message.apiKey !== 'string' || message.apiKey.length > 4096 || /[\r\n]/.test(message.apiKey))) return { ok: false, error: 'API Key 格式无效' };
        const existing = await config();
        const key = message.apiKey || (origin && configuredOrigin(existing.settings) === origin ? existing.apiKey : '');
        if (!key && settings.backend !== 'local') return { ok: false, error: '请为此服务填写 API Key' };
        if (controller.signal.aborted || capturedVersion !== version) return { ok: false, error: '配置已变化，请重新测试模型' };
        const result = await testModel({ settings, apiKey: settings.backend === 'local' ? 'local-inference' : key, signal: controller.signal, text: message.text,
          mode: message.context === 'video' ? 'vod' : 'deadline' }, providerOptions(settings));
        if (controller.signal.aborted || capturedVersion !== version) return { ok: false, error: '配置已变化，请重新测试模型' };
        if (settings.backend !== 'local') await serviceHistory.record(settings).catch(() => {});
        return { ok: true, ...result, ...(localState?.model ? { model: localState.model.name } : {}) };
      } catch (error) {
        const code = error instanceof ProviderError ? error.message : 'invalid-config';
        const errors: Record<string, string> = {
          'online-daily-limit-reached': '今日在线请求已达上限。可调高每日上限，或次日再试。',
          'online-budget-storage-unavailable': '无法保存在线请求计数，已停止发送。请检查浏览器存储。',
          'network-error': '无法连接翻译服务，请检查服务地址和网络',
          'LOCAL_MODEL_NOT_LOADED': '本地模型尚未成功加载，请先选择文件并加载',
          'LOCAL_MODEL_CHANGED': '本地模型已切换或卸载',
          'LOCAL_INFERENCE_FAILED': '本地推理失败，请查看模型运行状态',
          'LOCAL_TRANSLATION_SOURCE_REQUIRED': translationLanguageMessage('LOCAL_TRANSLATION_SOURCE_REQUIRED')!,
          'LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED': translationLanguageMessage('LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED')!,
          timeout: `模型测试超过 ${Math.ceil(timeoutMs / 1000)} 秒，请检查服务或调整对应超时`,
          'http-401': '服务拒绝 Key，请检查凭据', 'http-403': '服务拒绝访问，请检查凭据与模型权限',
          'http-400': '服务拒绝请求参数，请检查模型和思考强度', 'http-422': '服务拒绝请求参数，请检查模型和思考强度',
          'http-404': '未找到模型或翻译接口，请检查模型名称和服务地址', 'http-429': '模型测试被限流，请稍后重试',
          'invalid-response': '模型未返回有效的翻译结果，响应格式与翻译协议不兼容',
          'wrong-target-language': '返回内容明显不符合目标语言，未计为翻译成功；请检查目标语言或本地提示词模式',
          'untranslated-text': '模型原样返回了待译文本，未计为翻译成功',
          'instruction-leak': '模型把翻译指令也输出了，已拒绝该结果且不会缓存；可重新测试或强制重译',
          'output-truncated': '输出达到生成上限被截断，未计为翻译成功；可增加输出预算',
          'test-same-language': '源语言和目标语言相同，不能验证跨语言翻译；请选择不同语言或填写测试原文',
          'test-custom-text-required': '此源语言没有内置测试样例，请填写测试原文',
          'test-unchanged': '测试原文未发生变化，不能证明跨语言翻译有效',
          'invalid-test-text': '测试原文格式无效或超过 1000 字符',
          'response-too-large': '模型响应过大，测试未通过', 'redirect-blocked': '服务发生重定向，请填写最终翻译接口地址',
          cancelled: '测试已取消，请重新测试模型', 'invalid-config': '请检查服务地址、请求配置和思考强度',
        };
        return { ok: false, error: errors[code] ?? '模型测试失败，请检查服务状态',
          ...(error instanceof ModelTestError ? { result: error.result } : {}) };
      } finally { if (modelTest === controller) modelTest = undefined; }
    }
    if (message.type === 'save') {
      let settings: Settings;
      try { settings = await normalizeSubmittedSettings(message.settings, message.apiKey); }
      catch (error) {
        // Local drafts preserve online effort choices; hybrid validates that lane
        // here as well, before any settings or credentials have been written.
        if (error instanceof Error && error.message === 'unsupported-thinking-effort')
          return { ok: false, error: '当前请求配置不支持所选思考强度，请重新选择' };
        throw error;
      }
      const useHybrid = hybridEnabled(settings);
      if (useHybrid) {
        const identity = await hybridCapacityIdentity(settings);
        if (!settings.localModelId || !settings.bilibiliHybrid?.profiles.some(profile => profile.identity === identity))
          return { ok: false, error: '请为当前本地模型和参数设置混合容量' };
      }
      if (useHybrid || settings.enabled && settings.backend !== 'local') {
        const setupError = onlineSetupError(settings);
        if (setupError) return { ok: false, error: setupError };
      }
      const origin = configuredOrigin(settings);
      if ((settings.backend !== 'local' || useHybrid) && origin && !await browser.permissions.contains({ origins: [origin + '/*'] })) return { ok: false, error: '需要先授权该服务地址' };
      if (message.apiKey !== undefined && (typeof message.apiKey !== 'string' || message.apiKey.length > 4096 || /[\r\n]/.test(message.apiKey))) return { ok: false, error: 'API Key 格式无效' };
      if (!origin && typeof message.apiKey === 'string' && message.apiKey.trim()) return { ok: false, error: '请先填写服务地址' };
      const existing = await config();
      // A saved credential is bound to its destination. Changing origin requires a new key.
      const key = message.apiKey || (origin && configuredOrigin(existing.settings) === origin ? existing.apiKey : '');
      if (useHybrid && !key) return { ok: false, error: '请为混合模式配置在线服务 API Key' };
      if (useHybrid && existing.settings.localModelId !== settings.localModelId)
        return { ok: false, error: '本地模型已变化，请刷新容量设置' };
      cancelAll();
      await updateSettings(async latest => {
        if (useHybrid && latest.localModelId !== settings.localModelId)
          throw new Error('本地模型已变化，请刷新容量设置');
        if (!latest.enabled && settings.enabled) await localLoader.setPaused(false);
        else if (JSON.stringify(latest.localPerformance) !== JSON.stringify(settings.localPerformance)) await localLoader.invalidate();
        // Import/selection is its own immediate write; a stale full-form save cannot undo it.
        return { ...settings, localModelId: latest.localModelId };
      });
      // An unbound draft has no safe destination for a credential; leave any existing origin-bound key intact.
      if (origin) {
        await Promise.all([browser.storage.local.remove(KEY_STORAGE_KEY), browser.storage.session.remove(KEY_STORAGE_KEY)]);
        if (key) await (message.remember === true ? browser.storage.local : browser.storage.session).set({ [KEY_STORAGE_KEY]: { origin, value: key } });
      }
      await broadcast(true); void prepareLocal(); return safeConfig();
    }
    if (message.type === 'toggle') {
      let setupError: string | undefined;
      await updateSettings(async settings => {
      const wasEnabled = settings.enabled;
      const requestedEnabled = typeof message.enabled === 'boolean' ? message.enabled : settings.enabled;
      if (!wasEnabled && requestedEnabled && settings.backend !== 'local') {
        setupError = onlineSetupError(settings);
        if (setupError) return settings;
      }
      settings.enabled = requestedEnabled;
      if (message.displayMode === 'original' || message.displayMode === 'translated') settings.displayMode = message.displayMode;
      if (typeof message.targetLanguage === 'string' && message.targetLanguage.trim()) settings.targetLanguage = message.targetLanguage.trim().slice(0, 100);
      if (!wasEnabled && settings.enabled) await localLoader.setPaused(false);
      cancelAll(false); return settings;
      });
      if (setupError) return { ok: false, error: setupError };
      await broadcast(); void prepareLocal(); return safeConfig();
    }
    if (message.type === 'delete-key') {
      cancelAll(); await Promise.all([browser.storage.local.remove(KEY_STORAGE_KEY), browser.storage.session.remove(KEY_STORAGE_KEY)]);
      await broadcast(); return safeConfig();
    }
    if (message.type === 'clear-cache') { cancelAll(); await cache.clear(); await broadcast(true); return { ok: true }; }
    if (message.type === 'overview') {
      const [current] = await browser.tabs.query({ active: true, currentWindow: true });
      const id = current?.id, epoch = id === undefined ? 0 : navigationEpochs.get(id) ?? 0;
      const candidate = diagnosticCandidate(current?.url ?? '');
      const readStatus = async () => {
        if (id === undefined) return null;
        const tab = tabs.get(id), resource = await currentResource(id);
        if (!tab?.status || !resource || tab.status.resourceId !== resource.resourceId || Date.now() - tab.lastSeen >= 10000) return null;
        if (resource.platform === 'bilibili') {
          // A same-URL CID/player replacement need not raise tabs.onUpdated.
          // Cached ready status must still belong to the current top document.
          const captured = tab.session;
          const proof = await diagnosticReply(id, { type: resource.scenario === 'video' ? 'verify-resource-session' : 'verify-live-session', session: captured });
          if (proof?.ok !== true || tabs.get(id) !== tab || !sameSession(tab.session, captured) || Date.now() - tab.lastSeen >= 10000) return null;
        }
        return tab.status ?? null;
      };
      let status = await readStatus();
      let diagnostic = !status && candidate && id !== undefined ? await readAdapterDiagnostic(id, candidate) : null;
      const [safe, cacheStats] = await Promise.all([safeConfig(), cache.stats()]);
      // A ready state arriving while the diagnostic was in flight has precedence.
      status = await readStatus();
      const [latest] = await browser.tabs.query({ active: true, currentWindow: true });
      const latestResource = resourceFromUrl(latest?.url ?? '');
      const samePage = latest?.id === id && (id === undefined || (navigationEpochs.get(id) ?? 0) === epoch) &&
        sameResource(resourceFromUrl(current?.url ?? ''), latestResource);
      if (!samePage) { status = null; diagnostic = null; }
      return { ...safe, status, adapterDiagnostic: status ? null : diagnostic,
        bilibiliLiveCandidate: samePage && latestResource?.platform === 'bilibili' && latestResource.scenario === 'live',
        cache: cacheStats, engine: engine.stats() };
    }
    return { ok: false, error: '未知操作' };
  }

  registerTranslationShortcutHandler(browser.commands, async () => {
    await recoveredPause;
    await updateSettings(async latest => {
      const enabled = !latest.enabled;
      if (enabled && latest.backend !== 'local' && onlineSetupError(latest)) return latest;
      if (enabled) await localLoader.setPaused(false);
      cancelAll(false);
      return { ...latest, enabled };
    });
    await broadcast(); void prepareLocal();
  });
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.channel === LOCAL_CHANNEL) return;
    void handle(message, sender).then(reply => sendResponse(attachUiMessages(reply))).catch(() => sendResponse(attachUiMessages({ ok: false, error: '操作未完成，请检查配置或稍后重试' })));
    return true;
  });
  browser.tabs.onRemoved.addListener(tabId => {
    // A removed owner cannot retain a global zero-transport lock indefinitely.
    // Navigation alone is not sufficient: a live owner still needs restoration.
    void (async () => {
      for (let attempt = 0; attempt < 20 && userFilterGuardMutation; attempt++)
        await new Promise(resolve => setTimeout(resolve, 100));
      if (userFilterGuardMutation) return;
      userFilterGuardMutation = true;
      try {
        const guard = (await browser.storage.local.get(userFilterGuardKey))[userFilterGuardKey] as { kind?: string; tabId?: number } | undefined;
        if (guard?.kind === 'display-plan' && guard.tabId === tabId) await browser.storage.local.remove(userFilterGuardKey);
        const renderGuard = guardFields((await browser.storage.local.get(renderPreviewGuardKey))[renderPreviewGuardKey]);
        if (renderGuard?.kind === 'render-preview' && renderGuard.tabId === tabId) await browser.storage.local.remove(renderPreviewGuardKey);
      } finally { userFilterGuardMutation = false; }
    })().catch(() => {});
    prepareEntry(tabId);
    void frameGrants.remove(tabId);
    navigationEpochs.delete(tabId);
    retireTab(tabId);
    tabs.delete(tabId);
    for (const [key, controller] of running) if (key.startsWith(`${tabId}:`)) { controller.abort(); running.delete(key); }
  });
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url || change.status === 'loading') { navigationEpochs.set(tabId, (navigationEpochs.get(tabId) ?? 0) + 1); retireTab(tabId); prepareEntry(tabId); }
  });
});
