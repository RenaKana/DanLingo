import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { DEFAULT_SETTINGS } from '../src/core/config';
import { translationModelSummary } from '../src/core/model-summary';
import type { LocalRuntimeStatus } from '../src/local/auto-load';
import { clockStamp, liveEventId, resourceFromUrl, sameResource, sameSession, matchesResourceUrl, validBilibiliResource } from '../src/core/resource';
import { LiveScheduler, type LiveRelease } from '../src/core/live-scheduler';
import { nativeMetrics } from '../src/core/live-metrics';
import { needsTranslation } from '../src/core/messages';
import { protectText } from '../src/translation/text';
import { getTimeoutRetryPolicy } from '../src/core/timeout-retry';
import { emoteTokens } from '../src/platforms/bilibili-live/emotes';
import { bilibiliLiveView } from '../src/platforms/bilibili-live/view';
import { createLiveStatus } from '../src/ui/live-status';
import { createLiveRepairs } from '../src/ui/live-repairs';
import type { ChatCoverage, LiveConnection, LiveMetrics, LivePlaybackState, LiveSourceMessage, ResourceSession, RuntimeStatus, Settings, TranslationOutput } from '../src/core/types';

const BRIDGE = 'danlingo-live-v1';
export default defineContentScript({
  matches: ['https://www.youtube.com/*', 'https://live.nicovideo.jp/watch/*', 'https://live.bilibili.com/*'], runAt: 'document_start',
  main(ctx) {
    const documentSession = crypto.randomUUID();
    let generation = 0, adapterSession = '', disposed = false, lastSnapshot = 0, lastPublished = 0, readTicket = 0, configVersion = 0;
    type LocalRuntime = LocalRuntimeStatus;
    let settings: Settings = { ...DEFAULT_SETTINGS }, hasKey = false, session: ResourceSession | undefined, localRuntime: LocalRuntime | undefined;
    let performancePaused = false;
    let connection: LiveConnection = 'disconnected', coverage: ChatCoverage = 'unknown', note = '', sourceNote = '';
    let playback: LivePlaybackState = { paused: true, seeking: false, contentActive: false, atLiveEdge: false };
    const statusView = createLiveStatus();
    type ScanScope = 'visible' | 'queue' | 'loaded';
    const scans = new Map<string, { scope: ScanScope; configVersion: number; timer: ReturnType<typeof setTimeout>; chunk: number; count: number; requested: number; seen: Set<string> }>();
    const nativeChat = (platform?: string) => platform === 'youtube' || platform === 'bilibili';
    const configuredActive = () => !disposed && !performancePaused && settings.enabled && settings.displayMode === 'translated' && hasKey;
    const localRuntimeOf = (value: any): LocalRuntime | undefined => {
      if (!value || !['idle', 'loading', 'warming', 'ready', 'generating', 'error'].includes(value.phase) || typeof value.paused !== 'boolean') return undefined;
      return { phase: value.phase, paused: value.paused, ...(typeof value.error === 'string' ? { error: value.error.slice(0, 300) } : {}),
        ...(typeof value.modelName === 'string' ? { modelName: value.modelName.slice(0, 300) } : {}),
        ...(['off','on','low','medium','high','max'].includes(value.normalThinking) ? { normalThinking: value.normalThinking } : {}),
        ...(['off','on','low','medium','high','max'].includes(value.superChatThinking) ? { superChatThinking: value.superChatThinking } : {}),
        ...(typeof value.modelId === 'string' ? { modelId: value.modelId.slice(0, 200) } : {}), ...(typeof value.stage === 'string' ? { stage: value.stage.slice(0, 120) } : {}) };
    };
    const localReady = () => settings.backend !== 'local' || !!localRuntime && !localRuntime.paused && ['ready', 'generating'].includes(localRuntime.phase) && localRuntime.modelId === settings.localModelId;
    // Idle is available for demand, not a disabled translation service. Keeping
    // intake open lets the next eligible message reach the background autoloader
    // after an idle unload; heartbeats and untranslated symbols do not wake it.
    const localCanAdmit = () => localReady() || settings.backend === 'local' && localRuntime?.phase === 'idle' && !localRuntime.paused && !localRuntime.error;
    const runtimeNote = () => {
      if (performancePaused) return '性能测试中，翻译暂时暂停';
      if (settings.backend !== 'local' || localReady()) return '';
      if (localRuntime?.paused) return '本地模型自动加载已暂停，暂时显示原文';
      if (localRuntime?.phase === 'error' || localRuntime?.error) return `本地模型加载失败${localRuntime.error ? `：${localRuntime.error.slice(0, 120)}` : ''}，暂时显示原文`;
      if (localRuntime?.phase === 'idle') return '本地模型未加载，收到待译弹幕后自动加载';
      if (!localRuntime) return '正在读取本地模型状态，暂时显示原文';
      return '本地模型加载中，暂时显示原文';
    };
    const recentRepairs = createLiveRepairs({ request: value => repair(value), cancel: requestId => {
      const scan = scans.get(requestId); if (scan) { clearTimeout(scan.timer); scans.delete(requestId); }
      repairs.get(requestId)?.cancel();
    },
      timeoutMs: value => value.strategy === 'superchat' ? settings.superChatTimeoutMs ?? 15000 : 15000, scan: (scope = 'queue', requestedId) => {
      const id = requestedId ?? crypto.randomUUID();
      const unavailable = () => scope === 'loaded'
        ? recentRepairs.scanChunk({ scanId: id, candidates: [], status: 'unavailable', done: true }) : recentRepairs.scanStatus('unavailable', 0, scope);
      if ((session?.platform === 'niconico' || session?.platform === 'bilibili') && configuredActive() && connection === 'connected') {
        if (scans.has(id)) return;
        if (scans.size >= 3) { unavailable(); return; }
        scans.set(id, { scope, configVersion, timer: setTimeout(() => { scans.delete(id); unavailable(); }, 1800), chunk: 0, count: 0, requested: 0, seen: new Set() });
        post({ type: 'repair-scan', scope, scanId: id, platform: session.platform, resourceId: session.resourceId, adapterSession });
      } else unavailable();
    } });
    let presentationActive = false, chatMetrics: LiveMetrics | undefined;
    let chatRecentEligible = 0, chatRecentTranslated = 0;
    const nativePending = new Map<string, { eligible: boolean; at: number }>();
    const repairs = new Map<string, { cancel(): void; sourceId: string; session: ResourceSession; adapterSession: string; batchId?: string; cancelled: boolean; timer?: ReturnType<typeof setTimeout> }>();
    const repairTasks = new Map<string, { requestId: string; force: boolean; promise: Promise<TranslationOutput | undefined> }>();
    const emoteSources = new Map<string, { originalText: string; tokens: string[] }>();
    const outstanding = new Map<string, { session: ResourceSession; configVersion: number; ids: Set<string>; delivered: Set<string>; onResult: (output: TranslationOutput) => void }>();
    let nativeRecent: { at: number; eligible: boolean; translated: boolean }[] = [];
    let nativeCounts = { released: 0, translated: 0, original: 0, timedOut: 0, overloaded: 0, dropped: 0 };
    const post = (payload: Record<string, unknown>) => window.postMessage({ bridge: BRIDGE, from: 'content', ...payload }, location.origin);
    const optionalBatchId = (value: unknown): string | null | undefined => value === undefined ? undefined
      : typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
    function control() { post({ type: 'control', enabled: configuredActive() && localCanAdmit(), bufferMs: settings.liveBufferMs,
      bilibiliTimeoutRetryEnabled: settings.bilibiliTimeoutRetryEnabled === true,
      bilibiliTimeoutRetryExtraMs: settings.bilibiliTimeoutRetryExtraMs ?? 1000, bilibiliTimeoutRetryMode: settings.bilibiliTimeoutRetryMode ?? 'hold',
      youtubeTimeoutRetryEnabled: settings.youtubeTimeoutRetryEnabled === true,
      youtubeTimeoutRetryExtraMs: settings.youtubeTimeoutRetryExtraMs ?? 1000, youtubeTimeoutRetryMode: settings.youtubeTimeoutRetryMode ?? 'hold',
      niconicoTimeoutRetryEnabled: settings.niconicoTimeoutRetryEnabled === true,
      niconicoTimeoutRetryExtraMs: settings.niconicoTimeoutRetryExtraMs ?? 1000, niconicoTimeoutRetryMode: settings.niconicoTimeoutRetryMode ?? 'hold',
      targetLanguage: settings.targetLanguage, sourceLanguage: settings.liveSourceLanguage, superChatTimeoutMs: settings.superChatTimeoutMs, configVersion }); }
    function current(captured: ResourceSession | undefined) { return !disposed && sameSession(session, captured) && matchesResourceUrl(captured, location.href); }
    function synchronizedConfig(response: any) {
      if (Number.isSafeInteger(response?.configVersion) && response.configVersion >= 0 && response.configVersion !== configVersion) {
        readSettings(); return false; // A restarted worker has its own configuration generation.
      }
      return true;
    }
    function isViewingLive() { return connection === 'connected' && (nativeChat(session?.platform) ? presentationActive : !playback.paused && !playback.seeking && playback.contentActive && playback.atLiveEdge); }
    const scheduler = new LiveScheduler({ settings,
      async request(captured, items, signal, onResult) {
        const sentAt = clockStamp(), requestId = crypto.randomUUID();
        const capturedConfigVersion = configVersion;
        const cancel = () => { outstanding.delete(requestId); void browser.runtime.sendMessage({ type: 'cancel', requestId }).catch(() => {}); };
        signal.addEventListener('abort', cancel, { once: true });
        try {
          if (signal.aborted || !current(captured) || !configuredActive() || !localCanAdmit()) return [];
          const opened = await browser.runtime.sendMessage({ type: 'session-open', session: captured });
          if (!opened?.ok || signal.aborted || !current(captured) || !synchronizedConfig(opened) || capturedConfigVersion !== configVersion) return [];
          outstanding.set(requestId, { session: { ...captured }, configVersion: capturedConfigVersion, ids: new Set(items.map(item => item.id)), delivered: new Set(), onResult });
          const response = await browser.runtime.sendMessage({ type: 'translate', resourceId: captured.resourceId, session: captured, sentAt, requestId, items, configVersion: capturedConfigVersion });
          if (signal.aborted || !current(captured) || capturedConfigVersion !== configVersion) return [];
          if (!response?.ok) { note = typeof response?.error === 'string' ? response.error.slice(0, 140) : '后台暂不可用，到点显示原文'; return []; }
          note = '';
          return Array.isArray(response.items) ? response.items.slice(0, 200) : [];
        } catch { if (current(captured)) note = '扩展后台重连中，到点显示原文'; return []; }
        finally { outstanding.delete(requestId); signal.removeEventListener('abort', cancel); }
      },
      prepare(event: LiveRelease) {
        if (session?.platform === 'niconico' || session?.platform === 'bilibili') recentRepairs.prepared(event.source.sourceId, event.text);
        if (session) post({ type: 'prepared', platform: session.platform, resourceId: session.resourceId, adapterSession,
          sourceId: event.source.sourceId, originalText: event.source.originalText, text: event.text, cached:event.cached,
          preparedDelayMs:Math.max(0,(event.preparedAt??performance.now())-event.source.receivedAt) });
      },
      release(event) {
        if(session&&nativeChat(session.platform)&&!event.translated)post({type:'release-original',platform:session.platform,resourceId:session.resourceId,adapterSession,
          sourceId:event.source.sourceId,originalText:event.source.originalText});
        return true; // Native submitted/presented acknowledgements are counted separately.
      },
    });
    function cancelRepairs() { for (const pending of repairs.values()) pending.cancel(); repairs.clear(); repairTasks.clear(); }
    function clearSession(preserveRecent = false) {
      for (const scan of scans.values()) clearTimeout(scan.timer); scans.clear();
      cancelRepairs();
      emoteSources.clear();
      if (!preserveRecent) recentRepairs.clear(); else recentRepairs.cancelPending();
      statusView.repairControl(null);
      if (session) void browser.runtime.sendMessage({ type: 'session-close', session }).catch(() => {});
      scheduler.dispose(); outstanding.clear(); statusView.attach(null); session = undefined; adapterSession = ''; sourceNote = ''; nativePending.clear(); nativeRecent = [];
      presentationActive=false;chatMetrics=undefined;chatRecentEligible=0;chatRecentTranslated=0;
      nativeCounts = { released: 0, translated: 0, original: 0, timedOut: 0, overloaded: 0, dropped: 0 };
    }
    function player() {
      if (session?.platform === 'bilibili') return document.querySelector<HTMLElement>('#player-ctnr');
      return session?.platform === 'youtube' ? document.querySelector<HTMLElement>('#movie_player')
        : document.querySelector<HTMLVideoElement>("[data-layer-name='videoLayer'] video")?.closest<HTMLElement>('[data-player-layout]')
          ?? document.querySelector<HTMLElement>('[data-danlingo-live-player]') ?? null;
    }
    function publish(force = false) {
      const now = performance.now();
      if (disposed || !session || !current(session) || (!force && now - lastPublished < 1000)) return;
      lastPublished = now;
      const stats = scheduler.getStats();
      nativeRecent = nativeRecent.filter(r => now - r.at <= 60000).slice(-1200);
      for (const [id, pending] of nativePending) if (now - pending.at > 12000) nativePending.delete(id);
      const recent = nativeRecent.filter(r => r.eligible), native = session.platform === 'niconico';
      const recentEligible = native ? recent.length : chatRecentEligible;
      const recentTranslated = native ? recent.filter(r => r.translated).length : chatRecentTranslated;
      const slow = recentEligible >= 20 && recentTranslated / recentEligible < 0.9;
      const runtimeMessage = runtimeNote();
      const state: RuntimeStatus = { platform: session.platform, scenario: 'live', resourceId: session.resourceId,
        state: !settings.enabled || settings.displayMode === 'original' ? 'disabled' : !hasKey ? 'configuration-needed' : connection !== 'connected' || note || runtimeMessage || slow ? 'degraded' : 'ready',
        connection, coverage, messages: native ? stats.received : chatMetrics?.received??stats.received, translated: native ? nativeCounts.translated : chatMetrics?.translated??0,
        original: native ? nativeCounts.original : chatMetrics?.original??0, cacheHits: native?stats.cacheHits:chatMetrics?.cachedTranslated??0, queued: native?stats.queued:chatMetrics?.pending??stats.queued,
        inflight: stats.inflight, recentEligible, recentTranslated, timedOut: native ? nativeCounts.timedOut : chatMetrics?.timedOut??0,
        overloaded: native?stats.overloaded+nativeCounts.overloaded:chatMetrics?.overloaded??0, dropped:native?stats.dropped+nativeCounts.dropped:chatMetrics?.abandoned??0,
        ...(!native&&chatMetrics?{liveMetrics:chatMetrics}:{}),
        note: sourceNote || runtimeMessage || note || (slow ? '近期译文未达90%；可检查翻译服务与请求配置' : connection !== 'connected' ? '直播消息源未连接' : !isViewingLive() ? native ? '暂停、广告或未在直播点，等待恢复实时观看' : '聊天隐藏，暂停新增翻译' : ''),
      };
      const surface = player();
      const embeddedVideo = session.platform === 'bilibili' ? bilibiliLiveView(window as Window & typeof globalThis)?.document.querySelector('video') : null;
      statusView.attach(session.platform === 'youtube' ? surface?.closest<HTMLElement>('#player-container-outer') ?? surface : surface, embeddedVideo);
      statusView.update(state, translationModelSummary(settings, localRuntime));
      const captured = { ...session };
      void browser.runtime.sendMessage({ type: 'session-open', session: captured }).then(async opened => {
        if (!opened?.ok || !current(captured) || !synchronizedConfig(opened)) return;
        await browser.runtime.sendMessage({ type: 'live-presence', session: captured, active: configuredActive() && isViewingLive() });
        if (current(captured)) await browser.runtime.sendMessage({ type: 'status', status: state, session: captured });
      }).catch(() => {});
    }
    function applySettings(response: any) {
      if (disposed || !response?.ok || !response.settings) return;
      const previousConfigVersion = configVersion;
      const wasPaused = performancePaused;
      if (Number.isSafeInteger(response.configVersion) && response.configVersion >= 0) configVersion = response.configVersion;
      settings = response.settings; hasKey = response.hasKey === true; performancePaused = response.performancePaused === true;
      if (Object.hasOwn(response, 'localRuntime')) localRuntime = localRuntimeOf(response.localRuntime); note = '';
      scheduler.configure({ ...settings, enabled: configuredActive() && localCanAdmit() });
      if (response.resetTranslations || previousConfigVersion !== configVersion || performancePaused !== wasPaused) {
        cancelRepairs();
        scheduler.setConnection(performancePaused ? 'reconnecting' : connection); nativePending.clear(); recentRepairs.invalidate();
      }
      control(); publish(true);
    }
    function repair(d: any): Promise<TranslationOutput | undefined> {
      if (session?.platform !== 'bilibili') return runRepair(d);
      const key = JSON.stringify([adapterSession, d.sourceId, d.originalText]);
      const previous = repairTasks.get(key);
      if (previous && (!d.force || previous.force)) {
        post({ type: 'repair-start', platform: 'bilibili', resourceId: session.resourceId, adapterSession,
          sourceId: d.sourceId, originalText: d.originalText, requestId: previous.requestId, manual: d.manual, force: previous.force,
          ...(d.purpose === 'timeout' ? { purpose: 'timeout', timeoutMs: Math.max(1, Math.min(getTimeoutRetryPolicy(settings, 'bilibili')?.timeoutMs ?? 0, d.retryDeadlineAt - clockStamp())) } : {}) });
        return previous.promise;
      }
      if (previous) repairs.get(previous.requestId)?.cancel();
      const task = { requestId: d.requestId, force: d.force === true, promise: runRepair(d) };
      repairTasks.set(key, task);
      void task.promise.finally(() => { if (repairTasks.get(key) === task) repairTasks.delete(key); });
      return task.promise;
    }
    async function runRepair(d: any): Promise<TranslationOutput | undefined> {
      const batchId = optionalBatchId(d.batchId);
      const purpose = d.purpose === undefined ? undefined : ['pinned','timeout'].includes(d.purpose) ? d.purpose as 'pinned' | 'timeout' : null;
      const timeoutValid = d.timeoutMs === undefined || Number.isSafeInteger(d.timeoutMs) && d.timeoutMs >= (purpose === 'timeout' ? 1 : 1000) && d.timeoutMs <= (purpose === 'timeout' ? 2147483647 : 120000);
      const timeoutPolicy = purpose === 'timeout' && session && ['bilibili', 'youtube', 'niconico'].includes(session.platform)
        ? getTimeoutRetryPolicy(settings, session.platform as 'bilibili' | 'youtube' | 'niconico') : undefined;
      if (!session || !configuredActive() || connection !== 'connected' ||
          !localCanAdmit() || nativeChat(session.platform) && !isViewingLive() || session.platform === 'niconico' && d.strategy !== 'manual' ||
          purpose === null || batchId === null || !timeoutValid || repairs.size >= 300 || repairs.has(d.requestId) ||
          typeof d.requestId !== 'string' || !d.requestId || d.requestId.length > 100 || typeof d.sourceId !== 'string' || !d.sourceId || d.sourceId.length > 300 ||
          typeof d.originalText !== 'string' || !d.originalText.trim() || d.originalText.length > 1000 || !['superchat', 'manual'].includes(d.strategy) ||
          typeof d.manual !== 'boolean' || typeof d.force !== 'boolean' || d.force && !d.manual ||
          purpose === 'timeout' && (!timeoutPolicy || d.strategy !== 'manual' || d.manual !== false || d.force !== false || !Number.isFinite(d.retryDeadlineAt) || d.retryDeadlineAt <= clockStamp()) ||
          purpose === 'pinned' && (session.platform !== 'youtube' || d.strategy !== 'manual' || d.manual !== false || d.force !== false)) return;
      const captured = { ...session }, version = configVersion, adapter = adapterSession, requestId = d.requestId;
      const timeoutMs = purpose === 'timeout' ? Math.max(1, Math.min(timeoutPolicy!.timeoutMs, d.retryDeadlineAt - clockStamp()))
        : purpose === 'pinned' ? 15000 : d.strategy === 'superchat' ? settings.superChatTimeoutMs ?? 15000 : 15000;
      const deadlineAt = clockStamp() + timeoutMs, id = 'repair:' + requestId;
      let expired = false;
      const repairPurpose = nativeChat(captured.platform) || captured.platform === 'niconico' && purpose === 'timeout'
        ? purpose ?? (d.manual ? 'manual' : d.strategy) : undefined;
      const state: { cancel(): void; sourceId: string; session: ResourceSession; adapterSession: string; batchId?: string; cancelled: boolean; timer?: ReturnType<typeof setTimeout> } =
        { sourceId: d.sourceId, session: captured, adapterSession: adapter, ...(batchId ? { batchId } : {}), cancelled: false, cancel: () => {} };
      let cancelSent = false;
      const cancel = (reason: 'cancelled' | 'expired' = 'cancelled') => {
        if (reason === 'expired') expired = true; else state.cancelled = true;
        if (state.timer !== undefined) { clearTimeout(state.timer); state.timer = undefined; }
        if (repairs.get(requestId) === state) repairs.delete(requestId);
        if (cancelSent) return;
        cancelSent = true;
        if (captured.platform === 'bilibili') post({ type: 'repair-abort', platform: captured.platform, resourceId: captured.resourceId,
          adapterSession: adapter, sourceId: d.sourceId, requestId });
        void browser.runtime.sendMessage({ type: 'cancel', requestId }).catch(() => {});
      };
      state.cancel = cancel;
      repairs.set(requestId, state); state.timer = setTimeout(() => cancel('expired'), timeoutMs + (purpose === 'timeout' ? 0 : 100));
      if (captured.platform === 'bilibili') post({ type: 'repair-start', platform: captured.platform, resourceId: captured.resourceId,
        adapterSession: adapter, sourceId: d.sourceId, originalText: d.originalText, requestId, manual: d.manual, force: d.force,
        ...(purpose === 'timeout' ? { purpose, timeoutMs } : {}) });
      const stillOwned = () => repairs.get(requestId) === state && current(captured) && version === configVersion && adapter === adapterSession;
      const result = (status: string, output?: TranslationOutput, reason?: string) => {
        if (!stillOwned() || state.cancelled) return;
        if (purpose === 'timeout' && clockStamp() >= deadlineAt) { status = 'expired'; output = undefined; }
        post({ type: 'repair-result', platform: captured.platform, resourceId: captured.resourceId, adapterSession: adapter,
          requestId, sourceId: d.sourceId, status, text: output?.text, reason: reason ?? output?.reason, ...(batchId ? { batchId } : {}) });
      };
      try {
        const opened = await browser.runtime.sendMessage({ type: 'session-open', session: captured });
        if (!opened?.ok) { result('failed', undefined, 'background-rejected'); return { id, status: 'failed', reason: 'background-rejected' }; }
        if (state.cancelled || !current(captured) || configVersion !== version || !synchronizedConfig(opened)) return;
        if (expired) { result('expired'); return { id, status: 'expired' }; }
        const response = await browser.runtime.sendMessage({ type: 'translate', resourceId: captured.resourceId, session: captured, requestId,
          sentAt: clockStamp(), configVersion: version, forceTranslate: d.manual, force: d.force,
          ...(repairPurpose ? { repairPurpose } : {}), items: [{ id, text: d.originalText, remainingMs: Math.max(1, deadlineAt - clockStamp()), strategy: purpose === 'timeout' ? 'normal' : d.strategy,
            ...(captured.platform === 'bilibili' && emoteSources.get(d.sourceId)?.originalText === d.originalText ? { emoteTokens: emoteSources.get(d.sourceId)!.tokens } : {}) }] });
        if (!stillOwned() || state.cancelled) return { id, status: 'expired' };
        const output = response?.items?.find((item: TranslationOutput) => item.id === id);
        if (expired) { result('expired'); return { id, status: 'expired' }; }
        if (!response?.ok) { result('failed', undefined, 'background-rejected'); return { id, status: 'failed', reason: 'background-rejected' }; }
        result(output?.status || 'failed', output);
        return output;
      } catch {
        if (expired) { result('expired'); return { id, status: 'expired' }; }
        result('failed', undefined, 'background-unavailable');
        return { id, status: 'failed', reason: 'background-unavailable' };
      } finally { if (state.timer !== undefined) clearTimeout(state.timer); if (repairs.get(requestId) === state) repairs.delete(requestId); }
    }
    function readSettings() {
      const ticket = ++readTicket;
      void browser.runtime.sendMessage({ type: 'settings' }).then(r => { if (ticket === readTicket) applySettings(r); }).catch(() => {});
    }
    function receive(event: MessageEvent) {
      const d = event.data;
      if (disposed || event.source !== window || event.origin !== location.origin || !d || d.bridge !== BRIDGE || d.from !== 'adapter') return;
      const candidate = resourceFromUrl(location.href);
      const resource = candidate?.platform === 'bilibili'
        ? { platform: 'bilibili' as const, scenario: 'live' as const, resourceId: d.resourceId, urlResourceId: d.urlResourceId } : candidate;
      if (candidate?.platform === 'bilibili' && (!validBilibiliResource(resource!) || !matchesResourceUrl(resource, location.href))) return;
      if (!resource || resource.scenario !== 'live' || d.resourceId !== resource.resourceId || d.platform !== resource.platform ||
          typeof d.adapterSession !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(d.adapterSession)) return;
      if (d.type === 'snapshot') {
        if (!Number.isFinite(d.stamp) || Math.abs(clockStamp() - d.stamp) > 10000) return;
        if (!session || adapterSession !== d.adapterSession || !sameResource(session, resource)) {
          clearSession(resource.platform === 'niconico' && sameResource(session, resource)); adapterSession = d.adapterSession;
          session = { ...resource, sessionId: documentSession, generation: ++generation };
          if (resource.platform === 'niconico' || resource.platform === 'bilibili') statusView.repairControl(recentRepairs.host);
          scheduler.start(session); readSettings();
        }
        lastSnapshot = performance.now();
        connection = ['connecting','connected','reconnecting','disconnected','ended'].includes(d.connection) ? d.connection : 'disconnected';
        coverage = ['all','top'].includes(d.coverage) ? d.coverage : 'unknown';
        sourceNote = resource.platform==='youtube' ? d.reason==='native-chat-entry-unavailable'?'原生聊天入口暂不可用，保留原站显示':d.reason==='chat-hidden'?'聊天隐藏，暂停新增翻译':'' : '';
        if (resource.platform === 'bilibili') sourceNote = typeof d.reason === 'string' && d.reason ? (d.reason === 'surfaces-hidden' ? '弹幕与聊天均隐藏，暂停新增翻译' : d.reason === 'superchat-only' ? '已接入页面醒目留言；普通弹幕入口尚未确认' : 'Bilibili 原生入口未就绪或版本不支持，保留原站显示') : '';
        presentationActive = nativeChat(resource.platform)&&d.presentationActive===true;
        if(nativeChat(resource.platform)) {
          chatMetrics=nativeMetrics(d.liveMetrics);
          chatRecentEligible=Number.isInteger(d.recentEligible)&&d.recentEligible>=0&&d.recentEligible<=20000?d.recentEligible:0;
          chatRecentTranslated=Number.isInteger(d.recentTranslated)&&d.recentTranslated>=0&&d.recentTranslated<=chatRecentEligible?d.recentTranslated:0;
        }
        const p = d.playback;
        playback = { paused: p?.paused !== false, seeking: p?.seeking !== false, contentActive: p?.contentActive === true, atLiveEdge: p?.atLiveEdge === true };
        scheduler.setPresentation({releasePolicy:nativeChat(resource.platform)?'ready-in-order':'deadline',active:nativeChat(resource.platform)?presentationActive:null});
        scheduler.setConnection(connection); scheduler.setPlayback(playback); publish(); return;
      }
      if (!session || adapterSession !== d.adapterSession || !current(session)) return;
      if (d.type === 'session-ended' && session.platform === 'bilibili') { clearSession(); return; }
      if (d.type === 'repair-request') {
        if (session.platform === 'niconico' && d.purpose === 'timeout' && typeof d.sourceId === 'string' && typeof d.requestId === 'string') {
          recentRepairs.sync(d.sourceId, { state: 'translating', requestId: d.requestId });
          void repair(d).then(output => {
            if (output && ['translated', 'cached'].includes(output.status) && typeof output.text === 'string' && output.text.trim())
              recentRepairs.sync(d.sourceId, { state: 'translated', requestId: d.requestId, text: output.text, application: 'recent-only' });
            else recentRepairs.sync(d.sourceId, { state: 'expired', requestId: d.requestId });
          }).catch(() => recentRepairs.sync(d.sourceId, { state: 'expired', requestId: d.requestId }));
        } else void repair(d);
        return;
      }
      if (d.type === 'repair-cancel' && (nativeChat(session.platform) || session.platform === 'niconico')) {
        const cancelBatchId = optionalBatchId(d.batchId);
        if (cancelBatchId === null || typeof d.requestId !== 'string' || !d.requestId || d.requestId.length > 100 ||
            typeof d.sourceId !== 'string' || !d.sourceId || d.sourceId.length > 300) return;
        const pending = repairs.get(d.requestId);
        if (!pending || pending.sourceId !== d.sourceId || ((session.platform !== 'bilibili' || cancelBatchId !== undefined) && pending.batchId !== cancelBatchId) || !sameSession(pending.session, session) ||
            pending.adapterSession !== adapterSession || pending.cancelled) return;
        pending.cancel();
        if (session.platform === 'niconico') recentRepairs.sync(d.sourceId, { state: 'expired', requestId: d.requestId });
        return;
      }
      if (d.type === 'repair-record' && session.platform === 'bilibili' && typeof d.sourceId === 'string' && d.sourceId.length <= 300) {
        if (d.state === 'removed') {
          emoteSources.delete(d.sourceId);
          recentRepairs.remove(d.sourceId);
          for (const pending of repairs.values()) if (pending.sourceId === d.sourceId) pending.cancel();
          return;
        }
        if (typeof d.originalText !== 'string' || !d.originalText.trim() || d.originalText.length > 1000) return;
        if (d.emoteTokens !== undefined) {
          const tokens = emoteTokens(d.emoteTokens, d.originalText); if (!tokens) return;
          emoteSources.set(d.sourceId, { originalText: d.originalText, tokens });
          while (emoteSources.size > 300) emoteSources.delete(emoteSources.keys().next().value!);
        }
        recentRepairs.capture(d.sourceId, d.originalText, 'unprocessed', d.strategy === 'superchat' ? 'superchat' : 'manual');
        if (['unprocessed','translating','translated','failed','expired','unneeded'].includes(d.state) && Number.isSafeInteger(d.resultVersion) && d.resultVersion >= 0 &&
            (d.requestId === undefined || typeof d.requestId === 'string' && d.requestId.length <= 100) &&
            (d.text === undefined || typeof d.text === 'string' && d.text.trim() && d.text.length <= 2000)) {
          recentRepairs.sync(d.sourceId, { state: d.state, requestId: d.requestId, text: d.text, resultVersion: d.resultVersion,
            application: ['generated','native-updated','recent-only'].includes(d.application) ? d.application : undefined });
        }
        return;
      }
      if (d.type === 'repair-applied' && session.platform === 'bilibili' && typeof d.sourceId === 'string' && d.sourceId.length <= 300 &&
          Number.isSafeInteger(d.resultVersion) && d.resultVersion >= 0 && ['native-updated','recent-only'].includes(d.application)) {
        recentRepairs.sync(d.sourceId, { resultVersion: d.resultVersion, application: d.application }); return;
      }
      if (d.type === 'repair-candidates' && (session.platform === 'niconico' || session.platform === 'bilibili') && Array.isArray(d.candidates) && d.candidates.length <= 200 &&
          ['supported', 'partial', 'unavailable'].includes(d.status) && new TextEncoder().encode(JSON.stringify(d)).length <= 256 * 1024) {
        const scan = scans.get(d.scanId);
        if (!scan || scan.configVersion !== configVersion || scan.scope !== d.scope || scan.chunk >= 6 || d.chunkIndex !== scan.chunk || typeof d.done !== 'boolean' || scan.count + d.candidates.length > 600) return;
        scan.chunk++;
        const accepted = [];
        for (const row of d.candidates) if (typeof row?.sourceId === 'string' && row.sourceId.length <= 300 && typeof row.originalText === 'string' && row.originalText.length <= 1000 && row.originalText.trim()) {
          if (scan.seen.has(row.sourceId)) continue;
          scan.seen.add(row.sourceId); scan.count++;
          const state = ['unprocessed','queued','translating','translated','failed','expired','unneeded'].includes(row.state) ? row.state : 'unprocessed';
          const candidate = { sourceId: row.sourceId, originalText: row.originalText, strategy: row.strategy === 'superchat' ? 'superchat' as const : 'manual' as const,
            state, ...(typeof row.text === 'string' && row.text.trim() && row.text.length <= 2000 ? { text: row.text } : {}), supported: row.supported !== false };
          accepted.push(candidate);
          if (scan.scope !== 'loaded') {
            recentRepairs.capture(candidate.sourceId, candidate.originalText, state, candidate.strategy, candidate.supported);
            if (candidate.text) recentRepairs.prepared(candidate.sourceId, candidate.text);
            if (scan.scope === 'visible' && recentRepairs.repairVisible(candidate.sourceId)) scan.requested++;
          }
        }
        if (scan.scope === 'loaded') recentRepairs.scanChunk({ scanId: d.scanId, candidates: accepted, status: d.status, done: d.done });
        if (d.done) {
          clearTimeout(scan.timer); scans.delete(d.scanId);
          if (scan.scope !== 'loaded') recentRepairs.scanStatus(d.status, scan.count, scan.scope, scan.requested);
        }
        return;
      }
      if(d.type==='submitted'&&nativeChat(session.platform)&&typeof d.sourceId==='string'&&d.sourceId.length<=300) {
        // Submission is not a native display confirmation.
        scheduler.remove([liveEventId(resource,d.sourceId)]);return;
      }
      if (d.type === 'dropped' && session.platform === 'niconico' && typeof d.sourceId === 'string' && d.sourceId.length <= 300 && ['capacity', 'age', 'inactive', 'session-reset'].includes(d.reason)) {
        const pending = nativePending.get(d.sourceId);
        // Invalidation is a real cancellation of an intercepted event, not an
        // original-text delivery. Capacity may be rejected before intake.
        if (!pending && d.reason !== 'capacity') return;
        recentRepairs.failed(d.sourceId);
        nativePending.delete(d.sourceId); nativeCounts.dropped++; if (d.reason === 'capacity') nativeCounts.overloaded++;
        if (pending) nativeRecent.push({ at: performance.now(), eligible: pending.eligible, translated: false });
        scheduler.remove([liveEventId(resource, d.sourceId)]); return;
      }
      if (d.type === 'delivered' && session.platform === 'niconico') {
        const pending = typeof d.sourceId === 'string' ? nativePending.get(d.sourceId) : undefined;
        if (!pending) return;
        recentRepairs.delivered(d.sourceId, d.translated === true);
        nativePending.delete(d.sourceId);
        nativeCounts.released++;
        if (d.translated === true) nativeCounts.translated++; else { nativeCounts.original++; if (pending.eligible) nativeCounts.timedOut++; }
        nativeRecent.push({ at: performance.now(), eligible: pending.eligible, translated: d.translated === true }); return;
      }
      if (d.type !== 'events' || !Array.isArray(d.events) || d.events.length > 500) return;
      if (new TextEncoder().encode(JSON.stringify(d)).length > 256 * 1024) return;
      const now = performance.now(), stamp = clockStamp();
      const messages: LiveSourceMessage[] = [];
      for (const e of d.events) {
        if (!e || typeof e.sourceId !== 'string' || !e.sourceId || e.sourceId.length > 300 || typeof e.originalText !== 'string' ||
            !e.originalText || e.originalText.length > 1000 || !Number.isFinite(e.receivedAt) || e.receivedAt > stamp + 100 || stamp - e.receivedAt > 10000) continue;
        const m: LiveSourceMessage = { id: liveEventId(resource, e.sourceId), sourceId: e.sourceId, originalText: e.originalText,
          receivedAt: now - Math.max(0, stamp - e.receivedAt), translatable: e.translatable === true };
        if (resource.platform === 'bilibili' && e.emoteTokens !== undefined) {
          const tokens = emoteTokens(e.emoteTokens, e.originalText); if (!tokens) continue;
          m.emoteTokens = tokens;
        }
        if (typeof e.authorId === 'string' && e.authorId.length <= 200) m.authorId = e.authorId;
        if (Number.isFinite(e.sentAtEpochMs) && e.sentAtEpochMs > 0) m.sentAtEpochMs = e.sentAtEpochMs;
        if (resource.platform === 'niconico' && Number.isFinite(e.scheduledAt) && Math.abs(e.scheduledAt - stamp) <= 3000) m.scheduledAt = now + e.scheduledAt - stamp;
        messages.push(m);
        if (resource.platform === 'niconico' && nativePending.size < 2000 && !nativePending.has(e.sourceId)) nativePending.set(e.sourceId, {
          eligible: m.translatable && needsTranslation(m.originalText, settings.targetLanguage, settings.liveSourceLanguage) && !protectText(m.originalText).reason, at: now,
        });
        if (resource.platform === 'niconico' || resource.platform === 'bilibili') recentRepairs.capture(e.sourceId, e.originalText, resource.platform === 'bilibili' ? (m.translatable ? 'queued' : 'unneeded') : nativePending.get(e.sourceId)?.eligible ? 'queued' : 'unneeded');
      }
      if (Array.isArray(d.removes)) scheduler.remove(d.removes.slice(0, 1000).filter((id: unknown) => typeof id === 'string' && id.length <= 300).map((id: string) => liveEventId(resource, id)));
      if (Array.isArray(d.removeAuthors)) for (const id of d.removeAuthors.slice(0, 100)) if (typeof id === 'string' && id.length <= 200) scheduler.removeAuthor(id);
      scheduler.ingest(messages); publish();
    }
    const settingsListener = (message: any, sender: { id?: string; tab?: unknown }) => {
      if (sender.id !== browser.runtime.id || sender.tab !== undefined) return;
      if (message?.type === 'live-translation-result') {
        const pending = typeof message.requestId === 'string' ? outstanding.get(message.requestId) : undefined;
        const output = message.output;
        if (!pending || !current(pending.session) || !sameSession(message.session, pending.session) ||
            message.configVersion !== pending.configVersion || pending.configVersion !== configVersion ||
            typeof output?.id !== 'string' || !pending.ids.has(output.id) || pending.delivered.has(output.id) ||
            !['translated', 'cached'].includes(output.status) || typeof output.text !== 'string' || !output.text.trim() || output.text.length > 2000) return;
        pending.delivered.add(output.id);
        pending.onResult({ id: output.id, text: output.text, status: output.status });
        return;
      }
      if (message?.type === 'verify-live-session') return Promise.resolve({ ok: current(message.session) && (session?.platform !== 'bilibili' || performance.now() - lastSnapshot < 6000) });
      if (message?.type === 'settings-updated') { readTicket++; applySettings(message); }
      if (message?.type === 'local-runtime-updated') {
        const next = localRuntimeOf(message.localRuntime); if (!next) return;
        localRuntime = next; const admit = localCanAdmit();
        scheduler.configure({ ...settings, enabled: configuredActive() && admit });
        if (!admit) { cancelRepairs(); scheduler.setConnection('reconnecting'); }
        else scheduler.setConnection(connection);
        control(); publish(true);
      }
    };
    window.addEventListener('message', receive); browser.runtime.onMessage.addListener(settingsListener);
    const pageHide = () => { post({ type: 'control', enabled: false, bufferMs: settings.liveBufferMs,
      targetLanguage: settings.targetLanguage, sourceLanguage: settings.liveSourceLanguage, configVersion }); clearSession(); };
    const pageShow = () => { readSettings(); control(); };
    window.addEventListener('pagehide', pageHide); window.addEventListener('pageshow', pageShow);
    const timer = ctx.setInterval(() => {
      if (session && !matchesResourceUrl(session, location.href)) clearSession();
      if (session && performance.now() - lastSnapshot > 6000) { connection = 'disconnected'; note = '直播接入失效，停止新增翻译'; scheduler.setConnection(connection); }
      control(); publish();
    }, 1000);
    readSettings();
    ctx.onInvalidated(() => {
      disposed = true; control(); clearSession(); clearInterval(timer); statusView.dispose(); recentRepairs.dispose();
      window.removeEventListener('message', receive); browser.runtime.onMessage.removeListener(settingsListener);
      window.removeEventListener('pagehide', pageHide); window.removeEventListener('pageshow', pageShow);
    });
  },
});
