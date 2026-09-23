import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { DEFAULT_SETTINGS, SETTINGS_KEY, KEY_STORAGE_KEY, endpointOrigin, normalizeSettings, providerTimeoutMs, strategySettings } from '../src/core/config';
import { resourceFromUrl, sameResource, sameSession, validSession, cacheResource, localDeadline, clockStamp, matchesResourceUrl, resourceOrigin } from '../src/core/resource';
import { nativeMetrics } from '../src/core/live-metrics';
import { getTimeoutRetryPolicy } from '../src/core/timeout-retry';
import { prepareEmoteText } from '../src/platforms/bilibili-live/emotes';
import { adapterDiagnostic, diagnosticCandidate, parseAdapterDiagnostic } from '../src/core/adapter-diagnostic';
import { TranslationEngine, IndexedDbTranslationCache } from '../src/translation';
import { discoverModels, ProviderError } from '../src/translation/provider';
import { testModel } from '../src/translation/model-test';
import { PerformanceTest } from '../src/translation/performance-test';
import { addUsage, ChatCompletionsProvider } from '../src/translation/provider';
import { createLocalFetch, localControl } from '../src/local/bridge';
import { LOCAL_CHANNEL } from '../src/local/types';
import { withLocalRuntime } from '../src/local/provider-settings';
import { translationLanguageIssue, translationLanguageMessage } from '../src/local/translation-profile';
import { LocalAutoLoader } from '../src/local/auto-load';
import type { LocalRuntimeStatus } from '../src/local/auto-load';
import { ModelCatalogStore, modelCatalogScope } from '../src/core/model-catalog';
import { ServiceHistory } from '../src/core/service-history';
import { OnlineRequestBudget, OnlineBudgetError } from '../src/core/online-budget';
import { registerTranslationShortcutHandler } from '../src/core/translation-shortcut';
import { SettingsFrameGrants, settingsFrameToken, settingsHostOrigin } from '../src/core/settings-frame';
import { discoverConnectionModels } from '../src/translation/connection-discovery';
import type { ProviderSettings } from '../src/core/types';
import type { AdapterDiagnostic, RuntimeStatus, Settings, TranslationInput, TranslationOutput, ResourceSession } from '../src/core/types';

interface Sender { id?: string; url?: string; frameId?: number; documentId?: string; tab?: { id?: number; url?: string } }
interface TabState { status?: RuntimeStatus; lastSeen: number; session?: ResourceSession; documentId?: string }

export default defineBackground(() => {
  const cache = new IndexedDbTranslationCache();
  const keepAlive = () => {
    // Finite long-running operation guard, not a persistent background heartbeat.
    // https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers#keep_a_service_worker_alive
    const timer = setInterval(() => { void browser.runtime.getPlatformInfo().catch(() => {}); }, 20_000);
    return () => clearInterval(timer);
  };
  const onlineBudget = new OnlineRequestBudget();
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
  const liveRunning = new Set<string>();
  let version = 0;
  let credentialRejected = false;
  let modelLookup: AbortController | undefined;
  let modelTest: AbortController | undefined;
  let performanceTest: PerformanceTest | undefined;
  let localPerformanceBaseline: { id: string; generation: number; calls: number } | undefined;
  const TEST_PAUSE_KEY = 'performancePause.v1';
  type TestLease = { id: string; kind: 'performance' | 'local-benchmark'; benchmarkId?: string; cancelled: boolean; release: () => void; releasing?: Promise<void> };
  let testPause: TestLease | undefined;
  async function readyLocal(settings: ProviderSettings, waitForLoad = true) {
    try { return await localLoader.ready(settings, waitForLoad); }
    catch (error) { throw new ProviderError(error instanceof Error ? error.message : 'LOCAL_LOAD_FAILED'); }
  }
  const ready = (async () => {
    await browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await browser.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const stored = await browser.storage.local.get(SETTINGS_KEY);
    if (!stored[SETTINGS_KEY]) await browser.storage.local.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, reasoningProfileOverride: 'auto' } });
  })();
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
    if (testPause) return;
    const { settings } = await config();
    if (!testPause && stillCurrent() && (!onEntry || settings.localPreloadOnEntry) && settings.enabled && settings.displayMode === 'translated' && settings.backend === 'local' && settings.localModelId) {
      try { await localLoader.ready(settings); } catch { /* Loading/failure is published separately; native originals stay visible. */ }
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
    const [local, session] = await Promise.all([browser.storage.local.get([SETTINGS_KEY, KEY_STORAGE_KEY]), browser.storage.session.get(KEY_STORAGE_KEY)]);
    const settings = normalizeSettings(local[SETTINGS_KEY], { stored: true });
    const origin = endpointOrigin(settings.endpoint, settings.allowLocalHttp);
    const value = (record: any): string => record?.origin === origin && typeof record.value === 'string' ? record.value : '';
    const localKey = value(local[KEY_STORAGE_KEY]);
    return { settings, apiKey: value(session[KEY_STORAGE_KEY]) || localKey, remembered: !!localKey };
  }
  let settingsWrites: Promise<unknown> = Promise.resolve();
  function updateSettings(change: (latest: Settings) => Settings | Promise<Settings>): Promise<Settings> {
    const write = settingsWrites.catch(() => {}).then(async () => {
      const next = await change((await config()).settings);
      await browser.storage.local.set({ [SETTINGS_KEY]: next }); return next;
    });
    settingsWrites = write; return write;
  }
  async function safeConfig() {
    const { settings, apiKey, remembered } = await config();
    return { ok: true, settings, onlineBudget: await onlineBudget.read(settings.onlineRequestLimitPerDay), hasKey: settings.backend === 'local' ? !!settings.localModelId : !!apiKey, hasOnlineKey: !!apiKey, remembered, configVersion: version, performancePaused: !!testPause,
      ...(settings.backend === 'local' ? { localRuntime: await localLoader.status() } : {}) };
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
  function retireTab(tabId: number) {
    const tab = tabs.get(tabId); if (tab) { tab.session = undefined; tab.status = undefined; }
    engine.setLiveSession(`tab:${tabId}`, false);
    for (const [key, controller] of running) if (key.startsWith(`${tabId}:`)) { controller.abort(); running.delete(key); liveRunning.delete(key); }
  }
  const videoChanging = () => ({ ok: false, error: '视频正在切换，稍后继续准备', retryAfterMs: 500 });
  function cancelAll(stopTest = true) {
    version++; credentialRejected = false;
    modelLookup?.abort();
    modelTest?.abort();
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

  async function releaseTest(lease: TestLease) {
    if (lease.releasing) return lease.releasing;
    if (testPause !== lease) return;
    lease.releasing = (async () => {
      // Polling and the completion event may race; only one release may remove this lease.
      await browser.storage.session.remove(TEST_PAUSE_KEY);
      if (testPause !== lease) return;
      testPause = undefined; lease.release(); version++;
      await broadcast(); void prepareLocal();
    })();
    try { await lease.releasing; } catch (error) { lease.releasing = undefined; throw error; }
  }
  async function acquireTest(kind: TestLease['kind']): Promise<TestLease> {
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
    const receivedAt = clockStamp(), receivedNow = performance.now();
    if (!message || typeof message.type !== 'string') return { ok: false, error: '无效消息' };
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
        return { ok: true, idle: !modelTest && !testPause && performanceTest?.report.state !== 'running'
          && (settings.backend !== 'local' || running.size === 0 && !(work.pendingItems > 0) && !(work.activeRequests > 0)) };
      }
      const local = await localControl({ action: 'state' });
      await localLoader.observe(local.state);
      return { ok: true };
    }
    const embedded = await embeddedUi(sender, message.type === 'settings-ui-connect');
    const ui = trustedUi(sender) || !!embedded; const tabId = embedded ? null : contentTab(sender);
    if (!ui && tabId === null) return { ok: false, error: '不支持的消息来源' };
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
        retireTab(tabId); tab.session = { ...incoming }; tab.documentId = sender.documentId;
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
      return { ok: true, performancePaused: !!testPause, engineNotice: engine.stats().rateLimitedUntil ? '翻译服务限流，等待后继续准备' : '' };
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
      const key = `${tabId}:${requestId}`;
      let admissionController: AbortController | undefined;
      if (repairRequest) {
        if (running.has(key)) return { ok: false, error: '重复请求' };
        if (running.size >= 1024) return { ok: false, error: '准备队列繁忙，稍后继续', retryAfterMs: 1000 };
        admissionController = new AbortController(); running.set(key, admissionController); liveRunning.add(key);
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
        const configured = await config();
        const settings = live ? { ...configured.settings, sourceLanguage: configured.settings.liveSourceLanguage } : configured.settings;
        const apiKey = configured.apiKey;
        if (!settings.enabled || settings.displayMode === 'original') return { ok: false, error: '翻译已关闭' };
        const timeoutPolicy = getTimeoutRetryPolicy(settings, resource.platform);
        if (repairPurpose === 'timeout' && !timeoutPolicy) return { ok: false, error: '超时自动补翻已关闭' };
        if (!apiKey && settings.backend !== 'local') return { ok: false, error: '请先配置 API Key' };
        if (credentialRejected && settings.backend !== 'local') return { ok: false, error: '服务拒绝凭据，请检查设置并保存后重试' };
        const origin = endpointOrigin(settings.endpoint, settings.allowLocalHttp);
        if (settings.backend !== 'local' && !await browser.permissions.contains({ origins: [origin + '/*'] })) return { ok: false, error: '请在设置中授权翻译服务地址' };
        if (settings.backend === 'local') {
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
        items.push({ id: item.id, text: sourceText, strategy, deadlineAt: live
          ? localDeadline(item.remainingMs, message.sentAt, receivedAt, receivedNow, budget)
          : performance.now() + Math.min(providerTimeoutMs(settings), item.remainingMs) });
      }
      if (chars > (live ? 24000 : settings.maxBatchChars) || items.length > (live ? 200 : settings.batchSize)) return { ok: false, error: '批次超过配置限制' };
      // Configuration and permission reads can span a navigation; recheck before admission.
      if (!sameResource(await currentResource(tabId), resource) || (sessionBound && tabs.get(tabId)?.session !== liveSession)) return videoChanging();
      if (testPause || !admissionCurrent()) return { ok: false, error: testPause ? '性能测试中，翻译暂时暂停' : '请求已取消' };
      // IPC envelopes are independent of the API pool. Keep VOD's old 20/18 bound and room for live's 64 API slots.
      if (running.size - (admissionController ? 1 : 0) >= 1024 || (!live && running.size - liveRunning.size >= (engine.hasLiveWork() ? 18 : 20))) return { ok: false, error: '准备队列繁忙，稍后继续', retryAfterMs: 1000 };
      if (!admissionController && running.has(key)) return { ok: false, error: '重复请求' };
      if (requestVersion !== version || (live && message.configVersion !== undefined && message.configVersion !== requestVersion)) return { ok: false, error: '配置已变化' };
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
        const onResult = live ? (output: TranslationOutput) => {
          output = restoreOutput(output);
          if (capturedVersion !== version || controller.signal.aborted || running.get(key) !== controller || tabs.get(tabId)?.session !== liveSession ||
              !seen.has(output.id) || (output.status !== 'translated' && output.status !== 'cached') || typeof output.text !== 'string' || !output.text.trim() || output.text.length > 2000) return;
          // Do not wait for sibling results or accounting. The receiving document checks its own current session and deadline.
          void browser.tabs.sendMessage(tabId, { type: 'live-translation-result', requestId: message.requestId,
            session: liveSession, configVersion: capturedVersion, output: { id: output.id, text: output.text, status: output.status } },
          sender.documentId ? { documentId: sender.documentId, frameId: 0 } : { frameId: 0 }).catch(() => {});
        } : undefined;
        const responses = await Promise.all((['normal', 'superchat', 'manual'] as const).map(async strategy => {
          const selected = items.filter(item => (item.strategy ?? 'normal') === strategy);
          if (!selected.length) return { items: [], usage: undefined };
          return engine.translate({ resourceId: cacheResource(resource), settings: strategySettings(settings, pinnedRepair && strategy === 'manual' ? 'normal' : strategy), apiKey, items: selected, signal: controller.signal,
            mode: live ? 'deadline' : 'vod', priority, quotaScope: `tab:${tabId}`, onResult,
            forceTranslate: message.forceTranslate === true, force: message.force === true && message.forceTranslate === true });
        }));
        const byId = new Map(responses.flatMap(response => response.items).map(item => [item.id, restoreOutput(item)]));
        const response = { items: items.map(item => byId.get(item.id)).filter((item): item is TranslationOutput => item !== undefined), usage: responses.reduce((usage, row) => addUsage(usage, row.usage), undefined as import('../src/core/types').Usage | undefined) };
        const activeResource = await currentResource(tabId);
        if (capturedVersion !== version || controller.signal.aborted) return { ok: false, error: '配置或播放位置已变化' };
      if (!sameResource(activeResource, resource) || (sessionBound && tabs.get(tabId)?.session !== liveSession)) return videoChanging();
        if (response.items.some(item => item.reason === 'http-401' || item.reason === 'http-403')) credentialRejected = true;
        return { ok: true, ...response };
      } finally { if (running.get(key) === controller) { running.delete(key); liveRunning.delete(key); } }
      } finally { if (admissionController && running.get(key) === admissionController) { running.delete(key); liveRunning.delete(key); } }
    }
    // The page-side UI may adjust scheduling only; provider configuration and credentials remain UI-only.
    if (message.type === 'scheduling-settings' && tabId !== null) {
      const resourceId = await currentVideo(tabId);
      if (!resourceId || resourceId !== message.resourceId) return videoChanging();
      if ((await currentResource(tabId))?.platform === 'bilibili' && !liveSessionMatches(tabId, sender, message.session)) return videoChanging();
      if (!['all', 'window'].includes(message.translationScope) || !Number.isInteger(message.prefetchSeconds) || message.prefetchSeconds < 5 || message.prefetchSeconds > 3600) return { ok: false, error: '请输入 5–3600 秒' };
      const { settings } = await config();
      const updated = normalizeSettings({ ...settings, translationScope: message.translationScope, prefetchSeconds: message.prefetchSeconds });
      if (await currentVideo(tabId) !== resourceId) return videoChanging();
      await updateSettings(latest => ({ ...latest, translationScope: updated.translationScope, prefetchSeconds: updated.prefetchSeconds })); await broadcast(); return safeConfig();
    }
    if (!ui) return { ok: false, error: '此操作仅限扩展设置页' };
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
      const standalone = async () => { await browser.runtime.openOptionsPage(); return { ok: true, mode: 'standalone' }; };
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true }).catch(() => []);
      const origin = settingsHostOrigin(tab?.url ?? '');
      if (tab?.id === undefined || !origin) return standalone();
      const proof = await browser.tabs.sendMessage(tab.id, { type: 'settings-host-probe' }, { frameId: 0 }).catch(() => null);
      if (!proof?.ok || typeof proof.hostDocument !== 'string') return standalone();
      const previous = await frameGrants.get(tab.id);
      const grant = previous && previous.hostDocument === proof.hostDocument && previous.origin === origin && previous.token === proof.token
        ? previous : { tabId: tab.id, origin, token: crypto.randomUUID(), hostDocument: proof.hostDocument, createdAt: Date.now() };
      await frameGrants.put(grant);
      const result = await browser.tabs.sendMessage(tab.id, { type: 'settings-host-open', token: grant.token, hostDocument: grant.hostDocument }, { frameId: 0 }).catch(() => null);
      if (!result?.ok) { await frameGrants.remove(tab.id); return standalone(); }
      return { ok: true, mode: 'embedded' };
    }
    if (message.type === 'select-local-model') {
      if (typeof message.modelId !== 'string') return { ok: false, error: '请选择可用的本地模型' };
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
      if (performanceTest && localPerformanceBaseline?.id === performanceTest.report.id) {
        const local = await localControl({ action: 'state' });
        performanceTest.report.localInferenceCalls = local.state?.generation === localPerformanceBaseline.generation ? local.state.inferenceCalls - localPerformanceBaseline.calls : null;
      }
      return { ok: true, report: performanceTest?.snapshot() ?? null };
    }
    if (message.type === 'performance-stop') {
      if (testPause?.kind === 'performance') testPause.cancelled = true;
      performanceTest?.stop(); return { ok: true, report: performanceTest?.snapshot() ?? null };
    }
    if (message.type === 'performance-start') {
      if (testPause || performanceTest?.report.state === 'running' || modelTest) return { ok: false, error: '已有测试正在运行' };
      const settings = normalizeSettings(message.settings), existing = await config();
      const origin = endpointOrigin(settings.endpoint, settings.allowLocalHttp);
      if (settings.backend !== 'local' && !await browser.permissions.contains({ origins: [origin + '/*'] })) return { ok: false, error: '请先授权该服务地址' };
      if (message.apiKey !== undefined && (typeof message.apiKey !== 'string' || message.apiKey.length > 4096 || /[\r\n]/.test(message.apiKey))) return { ok: false, error: 'API Key 格式无效' };
      const key = message.apiKey || (endpointOrigin(existing.settings.endpoint, existing.settings.allowLocalHttp) === origin ? existing.apiKey : '');
      if (!key && settings.backend !== 'local') return { ok: false, error: '请为此服务填写 API Key' };
      // Constructor validates the replay before pausing any viewing session.
      let lease: TestLease | undefined;
      try {
        let run = new PerformanceTest(message.config, settings, settings.backend === 'local' ? 'local-inference' : key, providerOptions(settings));
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
        localPerformanceBaseline = localState ? { id: run.report.id, generation: localState.generation, calls: localState.inferenceCalls } : undefined;
        const owned = lease;
        void run.run().catch(() => run.stop('测试执行失败')).finally(async () => {
          try {
            // Provider cancellation can complete before native cooperative abort has settled.
            owned.cancelled = false;
            await drainTranslations(owned, native);
          } catch {
            if (settings.backend === 'local') await localControl({ action: 'cancel' }).then(reply => localLoader.observe(reply.state)).catch(() => {});
          } finally { await releaseTest(owned); }
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
      if (message.apiKey !== undefined && (typeof message.apiKey !== 'string' || message.apiKey.length > 4096 || /[\r\n]/.test(message.apiKey))) return { ok: false, error: 'API Key 格式无效' };
      const key = message.apiKey || (endpointOrigin(existing.settings.endpoint, existing.settings.allowLocalHttp) === endpointOrigin(settings.endpoint, settings.allowLocalHttp) ? existing.apiKey : '');
      return { ok: true, catalog: key ? await catalogs.read(await modelCatalogScope(settings, key)) : undefined };
    }
    if (message.type === 'models') {
      if (modelLookup) return { ok: false, error: '正在获取模型，请稍候' };
      const controller = new AbortController(); modelLookup = controller;
      const capturedVersion = version;
      try {
        const settings = normalizeSettings({ ...message.settings, thinkingEffort: undefined, superChatThinkingEffort: 'inherit' });
        if (settings.backend === 'local') { const local = await localControl({ action: 'list' }); return { ok: local.ok, models: local.models?.map(model => model.name) ?? [] }; }
        const origin = endpointOrigin(settings.endpoint, settings.allowLocalHttp);
        if (!await browser.permissions.contains({ origins: [origin + '/*'] })) return { ok: false, error: '请先授权该服务地址' };
        if (message.apiKey !== undefined && (typeof message.apiKey !== 'string' || message.apiKey.length > 4096 || /[\r\n]/.test(message.apiKey))) return { ok: false, error: 'API Key 格式无效' };
        const existing = await config();
        const key = message.apiKey || (endpointOrigin(existing.settings.endpoint, existing.settings.allowLocalHttp) === origin ? existing.apiKey : '');
        if (!key) return { ok: false, error: '请为此服务填写 API Key' };
        if (controller.signal.aborted || capturedVersion !== version) return { ok: false, error: '配置已变化，请重新获取模型' };
        const discovered = await discoverConnectionModels(settings, key, { signal: controller.signal });
        if (capturedVersion !== version) return { ok: false, error: '配置已变化，请重新获取模型' };
        const fetchedAt = Date.now();
        await catalogs.write(await modelCatalogScope(settings, key), discovered.models, fetchedAt);
        if (discovered.effectiveEndpoint) await catalogs.write(await modelCatalogScope({ ...settings, endpoint: discovered.effectiveEndpoint, endpointMode: discovered.effectiveEndpointMode }, key), discovered.models, fetchedAt);
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
      const controller = new AbortController(); modelTest = controller;
      const capturedVersion = version;
      let timeoutMs = 0;
      try {
        if (typeof message.settings?.model !== 'string' || !message.settings.model.trim()) return { ok: false, error: '请先选择或填写模型' };
        const settings = normalizeSettings(message.settings);
        const localState = settings.backend === 'local' ? await readyLocal(settings) : undefined;
        if (localState) Object.assign(settings, withLocalRuntime(settings, localState));
        if (settings.backend === 'local' && message.context !== 'video') settings.sourceLanguage = settings.liveSourceLanguage;
        const origin = endpointOrigin(settings.endpoint, settings.allowLocalHttp);
        timeoutMs = providerTimeoutMs(settings);
        if (settings.backend !== 'local' && !await browser.permissions.contains({ origins: [origin + '/*'] })) return { ok: false, error: '请先授权该服务地址' };
        if (message.apiKey !== undefined && (typeof message.apiKey !== 'string' || message.apiKey.length > 4096 || /[\r\n]/.test(message.apiKey))) return { ok: false, error: 'API Key 格式无效' };
        const existing = await config();
        const key = message.apiKey || (endpointOrigin(existing.settings.endpoint, existing.settings.allowLocalHttp) === origin ? existing.apiKey : '');
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
        return { ok: false, error: errors[code] ?? '模型测试失败，请检查服务状态' };
      } finally { if (modelTest === controller) modelTest = undefined; }
    }
    if (message.type === 'save') {
      const settings = normalizeSettings(message.settings);
      const origin = endpointOrigin(settings.endpoint, settings.allowLocalHttp);
      if (settings.backend !== 'local' && !await browser.permissions.contains({ origins: [origin + '/*'] })) return { ok: false, error: '需要先授权该服务地址' };
      if (message.apiKey !== undefined && (typeof message.apiKey !== 'string' || message.apiKey.length > 4096 || /[\r\n]/.test(message.apiKey))) return { ok: false, error: 'API Key 格式无效' };
      const existing = await config();
      // A saved credential is bound to its destination. Changing origin requires a new key.
      const key = message.apiKey || (endpointOrigin(existing.settings.endpoint, existing.settings.allowLocalHttp) === origin ? existing.apiKey : '');
      cancelAll();
      await updateSettings(async latest => {
        if (!latest.enabled && settings.enabled) await localLoader.setPaused(false);
        else if (JSON.stringify(latest.localPerformance) !== JSON.stringify(settings.localPerformance)) await localLoader.invalidate();
        // Import/selection is its own immediate write; a stale full-form save cannot undo it.
        return { ...settings, localModelId: latest.localModelId };
      });
      await Promise.all([browser.storage.local.remove(KEY_STORAGE_KEY), browser.storage.session.remove(KEY_STORAGE_KEY)]);
      if (key) await (message.remember === true ? browser.storage.local : browser.storage.session).set({ [KEY_STORAGE_KEY]: { origin, value: key } });
      await broadcast(true); void prepareLocal(); return safeConfig();
    }
    if (message.type === 'toggle') {
      await updateSettings(async settings => {
      const wasEnabled = settings.enabled;
      if (typeof message.enabled === 'boolean') settings.enabled = message.enabled;
      if (message.displayMode === 'original' || message.displayMode === 'translated') settings.displayMode = message.displayMode;
      if (typeof message.targetLanguage === 'string' && /^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{2,8}){0,2}$/.test(message.targetLanguage)) settings.targetLanguage = message.targetLanguage;
      if (!wasEnabled && settings.enabled) await localLoader.setPaused(false);
      cancelAll(false); return settings;
      });
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
      if (enabled) await localLoader.setPaused(false);
      cancelAll(false);
      return { ...latest, enabled };
    });
    await broadcast(); void prepareLocal();
  });
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.channel === LOCAL_CHANNEL) return;
    void handle(message, sender).then(sendResponse).catch(() => sendResponse({ ok: false, error: '操作未完成，请检查配置或稍后重试' }));
    return true;
  });
  browser.tabs.onRemoved.addListener(tabId => {
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
