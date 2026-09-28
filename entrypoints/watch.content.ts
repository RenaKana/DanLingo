import { NativeSupplyWatch } from '../src/diagnostics/native-supply-watch';
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { DEFAULT_SETTINGS, providerTimeoutMs } from '../src/core/config';
import { parseSources, watchIdFromUrl } from '../src/core/messages';
import { VideoScheduler } from '../src/core/scheduler';
import { parseBilibiliShadowUpdate } from '../src/core/bilibili-shadow';
import { SOURCE_CHUNK_BYTES, SOURCE_CHUNK_ITEMS } from '../src/core/source-stream';
import { parseVideoEligibility, videoBatchLimit } from '../src/core/video-policy';
import { BRIDGE } from '../src/platforms/niconico/native';
import { resourceFromUrl, matchesResourceUrl, sameSession, validSession } from '../src/core/resource';
import { adapterDiagnostic, adapterDiagnosticText, diagnosticCandidate, DIAGNOSTIC_LEASE_MS, parseAdapterDiagnostic } from '../src/core/adapter-diagnostic';
import { BUILD_ID } from '../src/core/build-identity';
import { createProgress } from '../src/ui/progress';
import { mountBilibiliFullscreenToggle } from '../src/ui/bilibili-fullscreen-toggle';
import { t } from '../src/i18n/text.ts';
import { bindLocalizedText } from '../src/ui/localized-text';
import { messageFromSource } from '../src/i18n/wire.ts';
import { BilibiliExperimentWatch, parseExperimentFilter, validExperimentRange, type ExperimentRange } from '../src/diagnostics/bilibili-experiment-watch';
import { parseUserFilterRows, parseUserFilterSummary } from '../src/platforms/bilibili/user-filter-wire';
import type { UserFilterRow } from '../src/platforms/bilibili/user-filter-session';
import { simulateUserFilterDemand } from '../src/diagnostics/user-filter-simulation';
import { DisplayPlanSession, displayPlanContextValid, type LivePlanOutput, type DisplayPlanFrame, type DisplayPlanEvent } from '../src/diagnostics/display-plan-session';
import { mountRenderPreview, type RenderExistingTranslation } from '../src/ui/render-preview';
import type { AdapterDiagnostic, PlaybackClock, Settings, RuntimeStatus, TranslationOutput, ResourceSession } from '../src/core/types';

function presentDisabledTranslation(progressHost: HTMLElement | null, notice: HTMLElement | null, disabled: boolean, fullscreen: boolean) {
  if (!progressHost || !notice) return;
  if (disabled) progressHost.style.setProperty('display', 'none', 'important');
  else progressHost.style.removeProperty('display');
  if (disabled && !fullscreen && progressHost.isConnected) {
    if (progressHost.nextElementSibling !== notice) progressHost.after(notice);
  } else notice.remove();
}

export default defineContentScript({
  matches: ['https://www.nicovideo.jp/*', 'https://www.bilibili.com/*'], runAt: 'document_start',
  main(ctx) {
    let disposed = false;
    let nativeSupply: NativeSupplyWatch | undefined;
    let settings: Settings = { ...DEFAULT_SETTINGS };
    let performancePaused = false;
    const bilibili = location.origin === 'https://www.bilibili.com', documentSession = crypto.randomUUID();
    let hasKey = false; let bridgeScope: { resourceId: string; urlResourceId?: string; session: string; epoch: number } = { resourceId: '', session: '', epoch: 0 };
    let generation = 0; let sourceGeneration = 0; let lastPublished = 0; let lastBridge = 0;
    let staged = { translated: 0, original: 0 }; let notice = ''; let engineNotice = ''; let ready = false;
    let settingsRead = 0; let revision = 0; let chunkIndex = -1;
    let configVersion = -1;
    let plannedRetiredFor = '', plannedRetireAttempt = '', plannedRetiring = false, plannedProblem = '';
    let plannedReport: any = null, plannedListReport: any = null;
    let plannedInputs = 0;
    let hybridStats: any;
    let legacyRetirement: Promise<void> | null = null;
    const plannedMode = () => bilibili && settings.bilibiliOwnedRelease === true && !nativeSupply?.officialActive;
    const plannedDisplay = () => plannedMode() && settings.enabled && settings.displayMode === 'translated' &&
      !displayPlanOwnsOverride && !renderOwnsOverride && !liveOwnsOverride && !experiment;
    const plannedConfigIdentity = () => `${configVersion}:${generation}`;
    const plannedRetireKey = () => `${bridgeScope.session}:${configVersion}`;
    type Experiment = ExperimentRange & { runId: string; configVersion: number; filterEnabled: boolean; singleDispatch: boolean;
      nativeReady: boolean; playing: boolean; started: boolean; active: boolean; ended: boolean; filterAt: number };
    let experiment: Experiment | null = null;
    let lastClock: PlaybackClock | null = null, sourceComplete = false;
    let userFilterOverride: boolean | null = null;
    let userFilterWireRevision = -1, userFilterAppliedRevision = 0, lastUserFilterAt = -Infinity;
    let userFilterSummary: Record<string, any> | null = null, userFilterSimulation: unknown = null;
    let userFilterLatencyMs: number | null = null;
    const userFilterDecisions = new Map<string, UserFilterRow>();
    let displayPlan: DisplayPlanSession | null = null, displayPlanError = '';
    let displaySources: import('../src/core/types').SourceMessage[] = [], displaySourceRevision = 0;
    let displayRuleSummary: Record<string, any> | null = null;
    let displayRules: UserFilterRow[] = [], displayRuleRevision = -1;
    let displayPlayback: { started: boolean; restored: boolean; seekCount: number;
      owner?: string; restoreDisposition?: string; playbackListeners?: number } = { started: false, restored: true, seekCount: 0 };
    let displayPlanPriorOverride: boolean | null = null;
    let displayPlanBusy = false;
    let displayPlanOwnsOverride = false;
    let renderPlan: DisplayPlanSession | null = null, renderPreview: ReturnType<typeof mountRenderPreview> | null = null;
    let renderBusy = false, renderOwnsOverride = false, renderError = '';
    let renderPriorOverride: boolean | null = null;
    let livePlan: DisplayPlanSession | null = null, liveBackground: any = null, liveGrant: any = null;
    let liveOwnsOverride = false, livePriorOverride: boolean | null = null, liveBusy = false;
    let liveState = 'unprepared', liveReason = '', liveMode = false, liveStatusAt = 0, liveStatusPending = false;
    let livePlaybackStarted = false;
    let liveMainCutoff: unknown = null, liveTailCutoff: unknown = null;
    const liveResults = new Map<string, RenderExistingTranslation>();
    const liveRequests = new Map<string, { onResult: (output: LivePlanOutput) => void; signal: AbortSignal }>();
    const livePageEvents: Record<string, unknown>[] = [];
    let pendingUserFilter: { revision: number; index: number; items: UserFilterRow[] } | null = null;
    const userFilterEnabled = () => bilibili && !nativeSupply?.officialActive &&
      (plannedDisplay() || nativeSupply?.active || nativeSupply?.reference || (userFilterOverride ?? settings.bilibiliUserFilters) === true);
    const videoRequests = new Map<string, {
      scope: { resourceId: string; session: string; generation: number; epoch?: number };
      configVersion: number; signal: AbortSignal; ids: Set<string>; receive: (output: TranslationOutput) => void; runId?: string;
    }>();
    let configuredFor: string | null = null;
    let collectionComplete = !bilibili;
    let nativeDiagnostic: AdapterDiagnostic | null = null, nativeDiagnosticAt = -Infinity;
    let diagnosticScope = diagnosticCandidate(location.href);
    function currentDiagnostic(): AdapterDiagnostic | null {
      const candidate = diagnosticCandidate(location.href);
      if (candidate !== diagnosticScope) { diagnosticScope = candidate; nativeDiagnostic = null; }
      if (!bilibili || !candidate || disposed) return null;
      if (ready && onCurrentPage() && performance.now() - lastBridge < DIAGNOSTIC_LEASE_MS) return adapterDiagnostic(candidate, 'waiting-status');
      return nativeDiagnostic?.urlResourceId === candidate && performance.now() - nativeDiagnosticAt < DIAGNOSTIC_LEASE_MS
        ? nativeDiagnostic : adapterDiagnostic(candidate, 'native-unresponsive');
    }
    function loseNative(retainSources = false) {
      if (ready) {
        const captured = bilibili ? resourceSession() : null;
        ready = false;
        if (captured && validSession(captured)) void browser.runtime.sendMessage({ type: 'session-close', session: captured }).catch(() => {});
        // A throttled background tab can miss the native heartbeat while the
        // same MAIN attachment and its unchanged source publisher remain live.
        if (retainSources && plannedMode() && lastClock)
          scheduler.snapshot(bridgeScope.resourceId, bridgeScope.session,
            { ...lastClock, contentActive: false }, undefined, bridgeScope.epoch);
        else scheduler.dispose();
      }
    }
    function resourceSession(): ResourceSession {
      return { platform: 'bilibili', scenario: 'video', resourceId: bridgeScope.resourceId, urlResourceId: bridgeScope.urlResourceId, sessionId: documentSession, generation };
    }
    function onCurrentPage() { return bilibili ? matchesResourceUrl(resourceSession(), location.href) : bridgeScope.resourceId === watchIdFromUrl(location.href); }
    const send = (payload: Record<string, unknown>) => window.postMessage({ bridge: BRIDGE, from: 'content', ...bridgeScope, generation, ...payload }, location.origin);
    const control = (extra: Record<string, unknown> = {}) => send({ type: 'control',
      enabled: nativeSupply?.officialActive ? false : plannedDisplay() ? true : nativeSupply?.active ? true : bilibili && settings.bilibiliNativeTranslationOnly && !plannedMode() ? false : displayPlanOwnsOverride || renderOwnsOverride || liveOwnsOverride ? false : experiment ? experiment.active && !experiment.ended && !performancePaused && hasKey : !performancePaused && settings.enabled && hasKey,
      displayMode: nativeSupply?.active || experiment ? 'translated' : settings.displayMode, bilibiliUserFilters: userFilterEnabled(),
      nativeSupply: plannedMode() ? null : nativeSupply?.controlValue() ?? null,
      plannedSupply: plannedDisplay() ? { enabled: true, configIdentity: plannedConfigIdentity(),
        sourceLanguage: settings.sourceLanguage, targetLanguage: settings.targetLanguage } : null,
      bilibiliOwnedRelease: plannedDisplay() || !nativeSupply?.officialActive && nativeSupply?.active === true && nativeSupply.owned,
      officialObservation: nativeSupply?.officialObservationValue() ?? null,
      shadowReference: nativeSupply?.referenceFullVideo === true,
      bilibiliShadowScheduler: !nativeSupply?.officialActive && !(nativeSupply?.active ? nativeSupply.owned : settings.bilibiliOwnedRelease) &&
        (nativeSupply?.active || nativeSupply?.reference || settings.bilibiliShadowScheduler === true) &&
        !experiment && !displayPlanOwnsOverride && !renderOwnsOverride && !liveOwnsOverride, ...extra });
    function normalSchedulerSettings(): Settings {
      return { ...settings, enabled: !nativeSupply?.officialActive && !displayPlanOwnsOverride &&
        !renderOwnsOverride && !liveOwnsOverride && !(bilibili && settings.bilibiliNativeTranslationOnly && !plannedMode()) &&
        !performancePaused && settings.enabled && hasKey && (!plannedMode() ||
          document.visibilityState !== 'hidden' && plannedRetiredFor === plannedRetireKey()),
        ...(plannedMode() ? { bilibiliNativeTranslationOnly: false, bilibiliShadowScheduler: false } : {}),
        ...(!bilibili ? { bilibiliOwnedRelease: false, bilibiliNativeTranslationOnly: false, bilibiliShadowScheduler: false } : {}) };
    }
    // Retire only this page's legacy experiment before reusing ordinary transport.
    // A blocked/foreign owner remains blocked; no playback or settings are changed.
    function retirePlannedLegacy(): void {
      if (!plannedMode() || !ready || !onCurrentPage() || configVersion < 0 || plannedRetiring) return;
      const key = plannedRetireKey();
      // Initial snapshot/configuration can rotate the page identity while the
      // session-open proof is in flight. Retry once for that new identity;
      // successful retirement remains stable when enabling the scheduler rotates it.
      const attemptKey = `${key}:${generation}`;
      if (plannedRetiredFor === key || plannedRetireAttempt === attemptKey) return;
      const captured = resourceSession();
      if (!validSession(captured)) return;
      plannedRetireAttempt = attemptKey; plannedRetiring = true;
      void (async () => {
        if (legacyRetirement) await legacyRetirement;
        else if (nativeSupply?.active) await nativeSupply.retire();
        const opened = await browser.runtime.sendMessage({ type: 'session-open', session: captured });
        if (!opened?.ok) throw new Error(opened?.error ?? '页面身份尚未就绪');
        const reply = await browser.runtime.sendMessage({ type: 'bilibili-owned-supply-retire', session: captured });
        if (!reply?.ok) throw new Error(reply?.error ?? '旧实验保护尚未释放');
        if (plannedMode() && key === plannedRetireKey()) { plannedRetiredFor = key; plannedProblem = ''; }
      })().catch(error => { if (key === plannedRetireKey()) plannedProblem = String(error.message ?? error).slice(0, 160); })
        .finally(() => {
          plannedRetiring = false;
          if (!disposed && plannedMode()) { scheduler.configure(normalSchedulerSettings()); control(); publish(true); }
        });
    }
    function clearUserFilterState() {
      userFilterWireRevision = -1; userFilterAppliedRevision = 0; lastUserFilterAt = -Infinity;
      userFilterSummary = null; userFilterSimulation = null; userFilterDecisions.clear(); pendingUserFilter = null;
      displayRuleSummary = null; displayRules = []; displayRuleRevision = -1;
    }
    function applyUserFilterRows(items: UserFilterRow[], reset: boolean) {
      if (reset) userFilterDecisions.clear();
      for (const row of items) userFilterDecisions.set(row.id, row);
      scheduler.updateUserFilter({ epoch: bridgeScope.epoch, revision: ++userFilterAppliedRevision, reset,
        items: userFilterEnabled() ? items : items.map(row => ({ ...row, state: 'unknown' as const })) });
    }
    function recordExperiment(run: Experiment, event: string, details: Record<string, unknown> = {}) {
      void browser.runtime.sendMessage({ type: 'bilibili-experiment-watch-event', runId: run.runId,
        session: resourceSession(), event, atMs: performance.now(), ...details }).catch(() => {});
    }
    const mirror = new BilibiliExperimentWatch(update => scheduler.updateEligibility(update));
    function experimentSettings(enabled: boolean): Settings {
      return { ...settings, enabled: enabled && !performancePaused && hasKey,
        displayMode: 'translated', translationScope: 'window', prefetchSeconds: experiment!.prefetchSeconds,
        videoBatchSize: experiment!.singleDispatch ? 1 : settings.videoBatchSize,
        batchSize: experiment!.singleDispatch ? 1 : settings.batchSize };
    }
    function experimentControl(run: Experiment, enabled: boolean) {
      send({ type: 'bilibili-experiment-control', sourceGeneration,
        payload: { runId: run.runId, filterEnabled: run.filterEnabled, enabled } });
    }
    function stopExperiment(reason: string, notify = true) {
      const run = experiment;
      if (!run) return;
      const captured = resourceSession();
      recordExperiment(run, 'stop', { reason });
      experimentControl(run, false);
      experiment = null;
      scheduler.configure({ ...settings, enabled: false });
      scheduler.dispose();
      if (ready && lastClock && onCurrentPage()) {
        scheduler.snapshot(bridgeScope.resourceId, bridgeScope.session, lastClock, undefined, bridgeScope.epoch);
        scheduler.updateSources(mirror.allSources(), [], true, sourceComplete);
        mirror.clearFilter();
      }
      scheduler.configure({ ...settings, enabled: !performancePaused && settings.enabled && hasKey });
      control(); publish(true);
      if (notify) void browser.runtime.sendMessage({ type: 'bilibili-experiment-stopped', runId: run.runId, reason, session: captured }).catch(() => {});
    }
    function enableExperimentWhenReady() {
      if (!experiment || experiment.active || experiment.ended || !experiment.playing || !experiment.nativeReady) return;
      experiment.started = experiment.active = true;
      control();
      if (lastClock) scheduler.snapshot(bridgeScope.resourceId, bridgeScope.session, lastClock, undefined, bridgeScope.epoch);
      publish(true);
    }
    function finishExperiment() {
      if (!experiment || experiment.ended) return;
      const captured = resourceSession();
      experiment.ended = true; experiment.active = false;
      recordExperiment(experiment, 'stop', { reason: 'range-complete' });
      experimentControl(experiment, false);
      scheduler.configure(experimentSettings(false));
      void browser.runtime.sendMessage({ type: 'bilibili-experiment-stopped', runId: experiment.runId,
        reason: 'range-complete', session: captured }).catch(() => {});
      publish(true);
    }
    const progress = createProgress(async (translationScope, prefetchSeconds) => {
      if (experiment) throw new Error('实验期间不能保存临时预译范围');
      const response = await browser.runtime.sendMessage({ type: 'scheduling-settings', resourceId: bridgeScope.resourceId, ...(bilibili ? { session: resourceSession() } : {}), translationScope, prefetchSeconds });
      if (!response?.ok) throw new Error(response?.error || '设置未保存');
      applySettings(response);
    }, () => { notice = ''; scheduler.retryFailures(); publish(true); }, async enabled => {
      try {
        if (enabled) {
          const guard = await browser.runtime.sendMessage({ type: 'bilibili-display-plan-guard', action: 'prepare', session: resourceSession() });
          if (!guard?.ok || !guard.zeroModelGuard) throw new Error(guard?.error ?? 'display-plan-guard-required');
          await displayPlanAction('run');
        } else {
          await displayPlanAction('cleanup');
          const released = await browser.runtime.sendMessage({ type: 'bilibili-display-plan-guard', action: 'cleanup', session: resourceSession() });
          if (!released?.ok) throw new Error(released?.error ?? 'display-plan-cleanup-failed');
        }
      } catch (error) {
        if (enabled && !displayPlanOwnsOverride) await browser.runtime.sendMessage({ type: 'bilibili-display-plan-guard', action: 'cleanup', session: resourceSession() }).catch(() => {});
        displayPlanError = error instanceof Error ? error.message : 'display-plan-failed'; throw error;
      }
      finally { publish(true); }
    });
    const fullscreenToggle = bilibili ? mountBilibiliFullscreenToggle(async enabled => {
      const session = resourceSession();
      if (disposed || !ready || !onCurrentPage()) throw new Error('视频正在切换，稍后继续准备');
      const opened = await browser.runtime.sendMessage({ type: 'session-open', session });
      if (!opened?.ok) throw new Error(opened?.error || '视频正在切换，稍后继续准备');
      if (disposed || !sameSession(session, resourceSession())) throw new Error('视频正在切换，稍后继续准备');
      const response = await browser.runtime.sendMessage({ type: 'video-translation-toggle', session, enabled });
      if (!response?.ok) throw new Error(response?.error || '设置未保存');
      if (!disposed && sameSession(session, resourceSession())) applySettings(response);
    }, async () => {
      const response = await browser.runtime.sendMessage({ type: 'translation-shortcut' });
      return response?.ok && typeof response.shortcut === 'string' ? response.shortcut : '';
    }) : null;
    if (bilibili && progress.renderPreviewHost) renderPreview = mountRenderPreview(progress.renderPreviewHost, {
      getClock: renderClock,
      onVisibilityChange: () => { void Promise.resolve().then(() => { tickRenderPlan(); tickLivePlan(); }); },
      onModeChange: mode => {
        liveMode = mode === 'live-local';
        if (liveMode && renderPlan?.running) void renderPreviewAction('cleanup').then(() =>
          browser.runtime.sendMessage({ type: 'bilibili-render-preview-guard', action: 'cleanup', session: resourceSession() }))
          .then(() => { renderPreview?.setEnabled(true); void refreshLiveState(); });
        else if (!liveMode && liveOwnsOverride) void livePreviewAction('stop');
        else if (liveMode) void refreshLiveState();
      },
      onLiveAction: action => livePreviewAction(action).then(() => {}),
      onToggle: async enabled => {
        try {
          if (liveMode || liveOwnsOverride) {
            if (enabled) { renderPreview?.setEnabled(true); await refreshLiveState(); }
            else { await livePreviewAction('cleanup'); await liveHost('cleanup'); }
            return;
          }
          if (enabled) {
            const guard = await browser.runtime.sendMessage({ type: 'bilibili-render-preview-guard', action: 'prepare', session: resourceSession() });
            if (!guard?.ok || !guard.zeroModelGuard) throw new Error(guard?.error ?? 'render-preview-guard-required');
            await renderPreviewAction('run');
          } else {
            await renderPreviewAction('cleanup');
            const guard = await browser.runtime.sendMessage({ type: 'bilibili-render-preview-guard', action: 'cleanup', session: resourceSession() });
            if (!guard?.ok) throw new Error(guard?.error ?? 'render-preview-cleanup-failed');
          }
        } catch (error) {
          if (enabled && !renderOwnsOverride) await browser.runtime.sendMessage({ type: 'bilibili-render-preview-guard', action: 'cleanup', session: resourceSession() }).catch(() => {});
          renderError = error instanceof Error ? error.message : 'render-preview-failed'; throw error;
        } finally { publish(true); }
      },
    });
    const scheduler = new VideoScheduler({
      settings: { ...settings, enabled: settings.enabled && hasKey },
      async request(resourceId, items, signal, priority, onResult) {
        if (nativeSupply?.active && !plannedMode()) return nativeSupply.request(items, signal, onResult);
        if (plannedMode() && (!plannedDisplay() || plannedRetiredFor !== plannedRetireKey()))
          return items.map(item => ({ id: item.id, status: 'original' as const, reason: 'planned-transport-unavailable' }));
        if (bilibili && settings.bilibiliNativeTranslationOnly && !plannedMode()) return items.map(item => ({ id: item.id, status: 'original' as const, reason: 'native-permit-required' }));
        const requestScope = { ...bridgeScope, generation };
        const planning = plannedDisplay() ? { epoch: bridgeScope.epoch, configIdentity: plannedConfigIdentity() } : null;
        const requestId = crypto.randomUUID();
        const run = experiment;
        const captured = bilibili ? resourceSession() : undefined;
        const cancel = () => { void browser.runtime.sendMessage(run
          ? { type: 'bilibili-experiment-cancel', runId: run.runId, requestId, session: captured }
          : { type: 'cancel', requestId }).catch(() => {}); };
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) { cancel(); throw new Error('cancelled'); }
        const requestVersion = configVersion;
        const excluded: TranslationOutput[] = [];
        if (run) {
          items = items.filter(item => {
            const source = mirror.source(item.id);
            if (source?.originalText === item.text && source.mediaTimeMs >= run.fromMs && source.mediaTimeMs <= run.toMs) return true;
            excluded.push({ id: item.id, status: 'original', reason: 'experiment-outside-range' });
            return false;
          });
          if (!run.started || run.ended || !items.length) {
            signal.removeEventListener('abort', cancel);
            return excluded.concat(items.map(item => ({ id: item.id, status: 'original' as const, reason: 'experiment-inactive' })));
          }
        }
        videoRequests.set(requestId, { scope: requestScope, configVersion: requestVersion, signal,
          ids: new Set(items.map(item => item.id)), receive: onResult, ...(run ? { runId: run.runId } : {}) });
        if (run) recordExperiment(run, 'request-start', { requestId, items: items.map(item => ({ id: item.id, text: item.text })), priority });
        try {
          if (captured) {
            const opened = await browser.runtime.sendMessage({ type: 'session-open', session: captured });
            if (!opened?.ok || signal.aborted || !isCurrent(requestScope)) throw new Error('cancelled');
          }
          // A rule revision can revoke part of the packet while session-open awaits.
          const currentIds = videoRequests.get(requestId)?.ids;
          items = items.filter(item => currentIds?.has(item.id));
          if (!items.length) return excluded;
          if (planning) {
            if (!plannedDisplay() || planning.configIdentity !== plannedConfigIdentity()) throw new Error('cancelled');
            // session-open can span a user pause or list change. Do not submit
            // a new batch once its currently dispatchable demand is gone.
            const demand = new Set(scheduler.currentNativeDemand().map(item => item.id));
            items = items.filter(item => demand.has(item.id));
            if (!items.length) return excluded;
            items = items.map(item => ({ ...item, configIdentity: planning.configIdentity }));
            plannedInputs += items.length;
          }
          const response = await browser.runtime.sendMessage({ type: run ? 'bilibili-experiment-translate' : 'translate',
            ...(run ? { runId: run.runId } : {}), requestId, resourceId, items, priority,
            ...(planning ? { planning, sentAt: Date.now() } : {}),
            ...(requestVersion >= 0 ? { configVersion: requestVersion } : {}), ...(captured ? { session: captured } : {}) });
          if (signal.aborted || !isCurrent(requestScope) || requestVersion !== configVersion || (run && experiment !== run)) throw new Error('cancelled');
          if (!response?.ok) {
            if (run) recordExperiment(run, 'request-end', { requestId, error: String(response?.error || 'background-rejected').slice(0, 100) });
            notice = response?.error || '扩展后台暂未就绪';
            if (response?.retryAfterMs) return excluded.concat(items.map(item => ({ id: item.id, status: 'deferred' as const, retryAfterMs: response.retryAfterMs })));
            return excluded.concat(items.map(item => ({ id: item.id, status: 'failed' as const, reason: 'background-rejected' })));
          }
          if (planning && response.hybridStats) hybridStats = response.hybridStats;
          const results = response.items as TranslationOutput[];
          if (!Array.isArray(results)) throw new Error('invalid response');
          if (run) recordExperiment(run, 'request-end', { requestId, items: results.map(item => ({ id: item.id, status: item.status })) });
          const failure = results.find(item => item.status === 'failed');
          notice = failure?.reason === 'http-401' || failure?.reason === 'http-403' ? '服务拒绝凭据，请检查 API Key 并保存' :
            failure?.reason === 'timeout' ? planning ? '翻译超时，本条弹幕已跳过' : `翻译请求超过 ${Math.ceil(providerTimeoutMs(settings) / 1000)} 秒，当前显示原文；可调整超时或批次后重试` :
            results.some(item => item.reason === 'http-429') ? '服务限流，等待后继续准备' :
            results.some(item => item.status === 'deferred') ? '请求额度等待中，稍后继续准备' :
            failure?.reason === 'http-400' || failure?.reason === 'http-422' ? '服务拒绝请求参数，请检查模型和思考强度' : failure ? planning ? '部分翻译失败，缺译弹幕已跳过' : '部分翻译失败，当前显示原文' : '';
          return excluded.concat(results);
        } catch (error) {
          if (run) recordExperiment(run, 'request-end', { requestId, error: 'cancelled-or-unavailable' });
          throw error;
        } finally { videoRequests.delete(requestId); signal.removeEventListener('abort', cancel); }
      },
      cancelItems(signal, ids) {
        if (nativeSupply?.active && !plannedMode()) { nativeSupply.cancelItems(signal, ids); return; }
        for (const [requestId, request] of videoRequests) {
          if (request.signal !== signal) continue;
          const removed = ids.filter(id => request.ids.delete(id));
          if (removed.length && !request.runId) void browser.runtime.sendMessage({
            type: 'cancel-video-items', requestId, ids: removed, session: resourceSession(),
          }).catch(() => {});
        }
      },
      prepared(items) {
        if (plannedDisplay()) {
          send({ type: 'prepared', plannedSupply: true,
            items: items.map(item => ({ ...item, configIdentity: plannedConfigIdentity() })) });
          return;
        }
        if (nativeSupply?.active && !plannedMode()) { nativeSupply.prepared(items); return; }
        if (bilibili && settings.bilibiliNativeTranslationOnly && !plannedMode()) return;
        if (!experiment) { send({ type: 'prepared', items }); return; }
        if (experiment.ended) return;
        const bounded = items.filter(item => {
          const source = mirror.source(item.id);
          return source?.originalText === item.originalText && source.mediaTimeMs >= experiment!.fromMs && source.mediaTimeMs <= experiment!.toMs;
        });
        if (bounded.length) {
          recordExperiment(experiment, 'prepared', { items: bounded.map(item => ({ id: item.id, originalText: item.originalText, text: item.text })) });
          send({ type: 'prepared', items: bounded });
        }
      },
      removed(ids) { for (let i = 0; i < ids.length; i += 500) send({ type: 'forget', ids: ids.slice(i, i + 500) }); },
      reset() { generation++; control({ clear: true }); },
      status() { publish(); },
    });
    nativeSupply = new NativeSupplyWatch({
      buildId: BUILD_ID,
      context: () => {
        const surface = document.querySelector<HTMLElement>('[data-danlingo-player="' + bridgeScope.session + '"]');
        const candidate = surface?.matches('video') ? surface as HTMLVideoElement : surface?.querySelector<HTMLVideoElement>('video');
        const video = candidate?.isConnected ? candidate : null;
        return { ready: !!video && ready && onCurrentPage() && performance.now() - lastBridge < 6000,
          epoch: bridgeScope.epoch, session: resourceSession(), configVersion, settings, snapshotAt: lastBridge,
          visible: document.visibilityState !== 'hidden', video,
          clock: lastClock && video ? { ...lastClock, mediaTimeMs: video.currentTime * 1000,
            paused: video.paused, seeking: video.seeking, playbackRate: video.playbackRate } : null };
      },
      original: id => mirror.source(id)?.originalText,
      demands: () => scheduler.currentNativeDemand(), rpc: message => browser.runtime.sendMessage(message),
      control: extra => control(extra), configure: value => scheduler.configure(value), send,
      close: (...args) => scheduler.closeNativeEvent(...args),
    });
    const nativeSupplyUi = progress.nativeSupplyHost;
    const progressHost = bilibili && nativeSupplyUi?.getRootNode
      ? (nativeSupplyUi.getRootNode() as ShadowRoot).host as HTMLElement : null;
    const disabledNotice = progressHost ? document.createElement('p') : null;
    if (disabledNotice) {
      disabledNotice.id = 'danlingo-disabled-notice';
      disabledNotice.style.cssText = 'box-sizing:border-box;margin:8px 0;max-width:100%;color:#656c76;font:14px/1.5 "Segoe UI","Microsoft YaHei",sans-serif';
      bindLocalizedText(disabledNotice, () => t('watch.enableTranslation'));
    }
    const updateDisabledPresentation = () => presentDisabledTranslation(progressHost, disabledNotice,
      !settings.enabled, !!document.fullscreenElement);
    if (progressHost) document.addEventListener('fullscreenchange', updateDisabledPresentation);
    const nativeSupplyButton = progress.nativeSupplyButton;
    let nativeUiBusy = false; let nativeUiTask: string | null = null;
    function plannedStatus() {
      const unavailable = (reason: string, text: string) => ({ state: 'unavailable', reason, text });
      if (!settings.enabled) return { state: 'disabled', reason: 'translation-disabled', text: '请开启“启用翻译”后使用提前名单' };
      if (settings.displayMode === 'original') return { state: 'disabled', reason: 'original-display', text: '原文显示中，提前翻译未运行' };
      if (!ready) return unavailable('native-not-ready', '控制未就绪，原生弹幕可能继续出现');
      if (plannedProblem) return unavailable(plannedProblem, `供给未就绪：${plannedProblem}`);
      if (plannedRetiredFor !== plannedRetireKey()) return { state: 'waiting', reason: 'legacy-retirement', text: '正在检查旧实验保护' };
      if (!plannedDisplay()) return { state: 'waiting', reason: 'diagnostic-override', text: '其他预览正在使用弹幕接口' };
      if (!plannedReport?.planned || plannedReport.configIdentity !== plannedConfigIdentity())
        return unavailable('planned-control-unconfirmed', '名单控制尚未接通，原生弹幕可能继续出现');
      if (plannedReport.pausedReason) return unavailable(plannedReport.pausedReason,
        /hook|insert|init-outside/.test(plannedReport.pausedReason)
          ? `控制已失效，原生弹幕可能继续出现（${plannedReport.pausedReason}）`
          : `供给已停止：${plannedReport.pausedReason}`);
      if (!plannedListReport?.known) {
        const reason = plannedListReport?.reason ?? 'plan-not-received';
        return { state: reason === 'playback-inactive' ? 'waiting' : 'unavailable', reason,
          text: reason === 'playback-inactive' ? '等待当前视频播放与页面恢复' : `名单尚未就绪：${reason}` };
      }
      if (plannedListReport.reason === 'playback-suspended') return { state: 'waiting',
        reason: 'playback-suspended', text: '等待播放，保留已准备译文' };
      if ((plannedListReport.totals?.selected ?? plannedListReport.selected ?? 0) === 0) {
        const labels: Record<string, string> = {
          'mode-stack-adjustment': '模式历史可能变化',
          'mode-stack-state-unavailable': '模式历史无法确认',
          'membership-rejected': '弹幕身份无法确认',
          'native-user-keyword': '关键词屏蔽',
          'native-user-regexp': '正则屏蔽',
          'native-user-sender': '发送者屏蔽',
          'native-ai-weight': '原生智能屏蔽',
          'density-cap': '密度限制',
        };
        const reasons = Object.entries(plannedListReport.rejected ?? {})
          .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
          .sort((a, b) => b[1] - a[1]).slice(0, 2)
          .map(([reason, count]) => `${labels[reason] ?? reason} ${count}`);
        if (reasons.length) return { state: 'running', reason: 'no-selected-candidates',
          text: `尚无入选；累计未入选：${reasons.join('、')}` };
      }
      return { state: 'running', reason: '', text: '缺译跳过，视频播放不受影响' };
    }
    function updateNativeSupplyUi() {
      const visible = bilibili && (settings.bilibiliNativeTranslationOnly || settings.bilibiliOwnedRelease || !!nativeSupply?.active);
      if (plannedMode()) {
        const counts = plannedReport?.counts ?? {};
        const stats = scheduler.getStats();
        const status = plannedStatus();
        progress.updateNativeSupply({ visible, planned: true, state: status.state, status: status.text, actionText: '', actionHidden: true, actionDisabled: true,
          candidates: stats.candidates, selected: plannedListReport?.totals?.selected ?? plannedListReport?.selected ?? 0,
          submitted: plannedInputs, cacheHits: stats.cacheHits, adopted: counts.adopted ?? 0, skipped: counts.ownedSuppressed ?? 0,
          hybrid: settings.bilibiliHybrid?.enabled ? hybridStats ?? null : null });
        return;
      }
      const stateLabel = { disabled: '未启动', waiting: '待启动', armed: '已准备', running: '运行中', paused: '已暂停', draining: '收尾中' };
      progress.updateNativeSupply({ visible, planned: false, state: nativeSupply?.active ? nativeSupply.state : 'disabled',
        status: nativeSupply?.active ? `${stateLabel[nativeSupply.state]} ${nativeSupply.displayReason}` : '未启动',
        actionText: nativeSupply?.grant ? '结束实验' : '启动0–45秒实验', actionHidden: false, actionDisabled: nativeUiBusy });
      nativeSupplyButton.title = '';
    }
    if (nativeSupplyButton) nativeSupplyButton.onclick = async () => {
      if (nativeUiBusy || !nativeSupply) return;
      if (plannedMode()) return;
      nativeUiBusy = true; updateNativeSupplyUi();
      try {
        if (nativeSupply.grant) {
          await nativeSupply.host('stop'); await nativeSupply.host('cleanup'); await nativeSupply.action('cleanup'); nativeUiTask = null;
        } else {
          const taskId = nativeUiTask ?? 'native-ui-' + crypto.randomUUID(), runId = taskId; nativeUiTask = taskId;
          const page = await nativeSupply.action('prepare', { runId });
          const host = await nativeSupply.host('prepare', { input: { taskId, runId, phase: 'main', epoch: page.epoch,
            ...(nativeSupply.owned ? { fromMs: page.range.fromMs, toMs: page.range.toMs } : {}) } });
          await nativeSupply.action('bind', { grant: host.grant }); await nativeSupply.action('start');
        }
      } catch (error) {
        nativeSupply.pause(error instanceof Error ? error.message : '实验启动失败');
        try {
          const status = await nativeSupply.host('status');
          if (nativeUiTask && status.grant?.taskId === nativeUiTask) {
            await nativeSupply.host('stop'); await nativeSupply.host('cleanup');
          }
        } catch { nativeSupply.reason += '；保护保留，请结束实验后重试'; }
      }
      finally { nativeUiBusy = false; updateNativeSupplyUi(); }
    };
    function isCurrent(scope: { resourceId: string; session: string; generation: number; epoch?: number }): boolean {
      return !disposed && onCurrentPage() && (!(nativeSupply?.active || plannedMode()) || scope.epoch === bridgeScope.epoch) &&
        scope.resourceId === bridgeScope.resourceId && scope.session === bridgeScope.session && scope.generation === generation;
    }
    function publish(force = false) {
      if (disposed || (!force && performance.now() - lastPublished < 500)) return;
      lastPublished = performance.now();
      fullscreenToggle?.update(settings.enabled, ready ? bridgeScope.session : '');
      const stats = scheduler.getStats();
      updateNativeSupplyUi();
      const waiting = performancePaused ? '性能测试中，翻译暂时暂停' : stats.inflight > 0 && settings.thinkingEffort !== 'off'
        ? `等待模型思考与翻译结果 · 单次最多 ${Math.ceil(providerTimeoutMs(settings) / 1000)} 秒` : '';
      const coverageNote = bilibili && !collectionComplete ? stats.sourceComplete && !stats.messages
        ? '后续分段加载后会继续检查弹幕' : '已加载分段预译中；尚未确认当前视频的全部分段' : '';
      // The filter summary is state, not an error message, and must not enter the
      // error-localization path while its diagnostic panel remains hidden.
      progress.attach(bridgeScope.session, bridgeScope.resourceId, bilibili ? 'bilibili' : 'niconico');
      progress.update(plannedMode() ? { ...settings, translationScope: 'window', prefetchSeconds: 5 } : nativeSupply?.active ? { ...nativeSupply.effectiveSettings(), enabled: nativeSupply.running || nativeSupply.state === 'draining' }
        : experiment ? experimentSettings(experiment.started && !experiment.ended) : settings,
        stats, nativeSupply?.active ? '' : engineNotice || notice || waiting || coverageNote,
        ready && hasKey, collectionComplete, staged, plannedMode() || nativeSupply?.active === true);
      if (bilibili) (progress as any).updateUserFilters?.(userFilterView());
      if (bilibili) (progress as any).updateDisplayPlan?.(displayPlan ? { ...displayPlan.view(), ...(displayPlanError ? { error: displayPlanError } : {}) } : {
        enabled: false, connected: ready && onCurrentPage(), resourceId: bridgeScope.resourceId, status: 'disabled',
        parameters: { lookaheadMs: 10000, freezeMs: 5000, bucketMs: 1000, limit: 2 }, frozenBuckets: 0,
        selected: 0, translationNeeded: 0, unknown: 0, upcoming: [], error: displayPlanError || undefined,
      });
      updateDisabledPresentation();
      const enabled = experiment ? experiment.active && !experiment.ended : settings.enabled;
      const status: RuntimeStatus = {
        state: resourceFromUrl(location.href)?.scenario !== 'video' ? 'unsupported' : !enabled ? 'disabled' : !hasKey ? 'configuration-needed' : !ready ? 'finding-player' : notice || engineNotice ? 'degraded' : stats.queued ? 'translating' : 'ready',
        platform: bilibili ? 'bilibili' : 'niconico', scenario: 'video',
        resourceId: bridgeScope.resourceId, messages: stats.messages, translated: staged.translated, original: staged.original,
        cacheHits: stats.cacheHits, queued: stats.queued, prepared: stats.translated, failed: stats.failed,
        nearTotal: stats.nearTotal, nearPrepared: stats.nearPrepared, inflight: stats.inflight, sourceComplete: stats.sourceComplete && collectionComplete,
        videoCandidates: stats.candidates, videoFiltered: stats.filtered, videoEligibilityUnknown: stats.eligibilityUnknown,
        videoEffectiveScope: stats.effectiveScope, videoDisplayState: stats.displayState,
        note: engineNotice || notice || waiting || (ready ? coverageNote : `等待受支持的 ${bilibili ? 'Bilibili' : 'Niconico'} 播放器`),
      };
      status.noteMessage = messageFromSource(status.note);
      const statusScope = { ...bridgeScope, generation };
      void (async () => {
        const captured = bilibili ? resourceSession() : undefined;
        if (captured) {
          if (!ready || !validSession(captured) || !onCurrentPage()) return;
          const opened = await browser.runtime.sendMessage({ type: 'session-open', session: captured });
          if (!opened?.ok || !isCurrent(statusScope)) return;
        }
        return browser.runtime.sendMessage({ type: 'status', status, ...(captured ? { session: captured } : {}) });
      })().then(response => {
        if (!response) return;
        if (typeof response.performancePaused === 'boolean' && response.performancePaused !== performancePaused) readSettings();
        if (isCurrent(statusScope)) {
          engineNotice = typeof response?.engineNotice === 'string' ? response.engineNotice.slice(0, 180) : '';
          if (response.hybridStats) hybridStats = response.hybridStats;
        }
      }).catch(() => {});
    }
    function applySettings(response: any) {
      if (!response?.ok || !response.settings) return;
      if (nativeSupply?.active && !settings.bilibiliOwnedRelease && !response.settings.bilibiliOwnedRelease &&
          !nativeSupply.waiting && response.configVersion !== configVersion) nativeSupply.pause('configuration-changed');
      if (liveOwnsOverride && Number.isSafeInteger(response.configVersion) && response.configVersion !== configVersion)
        stopLiveSupply('configuration-changed');
      const changedRenderConfig = renderOwnsOverride && Number.isSafeInteger(response.configVersion) && response.configVersion !== configVersion;
      if (changedRenderConfig) { renderPlan?.stop('configuration-changed'); renderPreview?.setEnabled(false); }
      const changedPlanConfig = displayPlanOwnsOverride && Number.isSafeInteger(response.configVersion) &&
        response.configVersion !== configVersion;
      if (changedPlanConfig) displayPlan?.stop('configuration-changed');
      const changedExperimentConfig = experiment && Number.isSafeInteger(response.configVersion) && response.configVersion !== experiment.configVersion;
      if (changedExperimentConfig) {
        settings = response.settings; hasKey = response.hasKey === true || bilibili && settings.bilibiliOwnedRelease === true && settings.bilibiliHybrid?.enabled === true && response.hasHybridConfig === true; performancePaused = response.performancePaused === true;
        configVersion = response.configVersion;
        stopExperiment('configuration-changed');
      }
      const strictTurnedOff = (settings.bilibiliNativeTranslationOnly || settings.bilibiliOwnedRelease) &&
        !(response.settings.bilibiliNativeTranslationOnly || response.settings.bilibiliOwnedRelease);
      const supplyModeChanged = !!settings.bilibiliOwnedRelease !== !!response.settings.bilibiliOwnedRelease;
      settings = response.settings; hasKey = response.hasKey === true || bilibili && settings.bilibiliOwnedRelease === true && settings.bilibiliHybrid?.enabled === true && response.hasHybridConfig === true; performancePaused = response.performancePaused === true; notice = ''; engineNotice = ''; hybridStats = undefined;
      if ((strictTurnedOff || supplyModeChanged || settings.bilibiliOwnedRelease) && nativeSupply?.active) {
        legacyRetirement = nativeSupply.retire();
        void legacyRetirement.catch(error => { plannedProblem = error instanceof Error ? error.message : 'cleanup-failed'; })
          .finally(() => { legacyRetirement = null; });
      }

      if (Number.isSafeInteger(response.configVersion) && response.configVersion >= 0) configVersion = response.configVersion;
      if (bilibili && settings.bilibiliNativeTranslationOnly && !settings.bilibiliOwnedRelease) nativeSupply?.armSetting();
      scheduler.configure(nativeSupply?.active ? nativeSupply.effectiveSettings() : experiment ? experimentSettings(!experiment.ended) :
        normalSchedulerSettings());
      retirePlannedLegacy();
      if (response.resetTranslations) {
        if (experiment) stopExperiment('settings-reset');
        scheduler.dispose(); revision = 0; chunkIndex = -1; collectionComplete = !bilibili; sourceGeneration = generation; control({ resync: true });
        mirror.resetSources(); sourceComplete = false;
      }
      control(); publish(true);
      if (changedPlanConfig) void displayPlanAction('cleanup').then(async () => {
        const reply = await browser.runtime.sendMessage({ type: 'bilibili-display-plan-guard', action: 'cleanup', session: resourceSession() });
        if (!reply?.ok) throw new Error(reply?.error ?? 'display-plan-cleanup-failed');
        readSettings();
      }).catch(error => { displayPlanError = error.message; publish(true); });
      if (changedRenderConfig) void renderPreviewAction('cleanup').then(async () => {
        const reply = await browser.runtime.sendMessage({ type: 'bilibili-render-preview-guard', action: 'cleanup', session: resourceSession() });
        if (!reply?.ok) throw new Error(reply?.error ?? 'render-preview-cleanup-failed');
        readSettings();
      }).catch(error => { renderError = error.message; publish(true); });
    }
    function readSettings() {
      const ticket = ++settingsRead;
      void browser.runtime.sendMessage({ type: 'settings' }).then(response => {
        if (!disposed && ticket === settingsRead) applySettings(response);
      }).catch(() => { if (ticket === settingsRead) notice = '扩展后台未就绪'; });
    }
    function receive(event: MessageEvent) {
      const d = event.data;
      if (event.source !== window || event.origin !== location.origin || !d || d.bridge !== BRIDGE || d.from !== 'native') return;
      if (d.type === 'unavailable') {
        if (bilibili) {
          const diagnostic = parseAdapterDiagnostic(d.diagnostic, diagnosticCandidate(location.href));
          if (!diagnostic) return;
          diagnosticScope = diagnostic.urlResourceId; nativeDiagnostic = diagnostic; nativeDiagnosticAt = performance.now();
          notice = adapterDiagnosticText(diagnostic);
          stopExperiment('native-unavailable');
          loseNative();
        } else { notice = String(d.reason || '').slice(0, 120); ready = false; scheduler.dispose(); }
        publish(); return;
      }
      if (bilibili ? !matchesResourceUrl({ platform: 'bilibili', scenario: 'video', resourceId: d.resourceId, urlResourceId: d.urlResourceId }, location.href) : d.resourceId !== watchIdFromUrl(location.href)) return;
      if (typeof d.session !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(d.session) || !Number.isSafeInteger(d.epoch) || d.epoch < 0) return;
      if (bilibili && d.session === bridgeScope.session && d.resourceId === bridgeScope.resourceId && d.epoch === bridgeScope.epoch) {
        if (!plannedMode()) nativeSupply?.native(d);
        else {
          if (d.type === 'bilibili-native-supply-report') plannedReport = d.report;
          if (d.type === 'bilibili-owned-release-report') plannedListReport = d.report;
          const e = d.type === 'bilibili-native-supply-event' ? d.event : null;
          if (e?.closed && typeof e.id === 'string' && e.epoch === bridgeScope.epoch && Number.isSafeInteger(e.predictionEpoch)) {
            const original = e.originalText ?? mirror.allSources().find(row => row.id === e.id)?.originalText;
            if (original) scheduler.closeNativeEvent(e.id, original, e.epoch, e.predictionEpoch, e.reason ?? e.type);
          }
        }
      }
      if (bilibili && d.type === 'bilibili-shadow') {
        if (d.session !== bridgeScope.session || d.resourceId !== bridgeScope.resourceId || d.epoch !== bridgeScope.epoch ||
          d.sourceGeneration !== sourceGeneration || new TextEncoder().encode(JSON.stringify(d)).length > SOURCE_CHUNK_BYTES) return;
        const update = parseBilibiliShadowUpdate(d);
        if (update) scheduler.updateShadow(update);
        return;
      }
      if (d.type === 'video-eligibility') {
        if (d.session !== bridgeScope.session || d.resourceId !== bridgeScope.resourceId || d.epoch !== bridgeScope.epoch ||
            d.sourceGeneration !== sourceGeneration || new TextEncoder().encode(JSON.stringify(d)).length > SOURCE_CHUNK_BYTES) return;
        const eligibility = parseVideoEligibility(d);
        if (eligibility) mirror.normalUpdate(eligibility);
        return;
      }
      if (bilibili && d.type === 'bilibili-user-filter') {
        if (d.session !== bridgeScope.session || d.resourceId !== bridgeScope.resourceId || d.epoch !== bridgeScope.epoch ||
            d.sourceGeneration !== sourceGeneration || new TextEncoder().encode(JSON.stringify(d)).length > SOURCE_CHUNK_BYTES ||
            !Number.isSafeInteger(d.revision) || d.revision < userFilterWireRevision ||
            !Number.isSafeInteger(d.index) || d.index < 0 || typeof d.complete !== 'boolean') return;
        const items = parseUserFilterRows(d.items), summary = parseUserFilterSummary(d.summary);
        if (!items || !summary) return;
        if (d.index === 0) pendingUserFilter = { revision: d.revision, index: 0, items: [] };
        if (!pendingUserFilter || pendingUserFilter.revision !== d.revision || pendingUserFilter.index !== d.index ||
            pendingUserFilter.items.length + items.length > 20000) { pendingUserFilter = null; return; }
        pendingUserFilter.items.push(...items); pendingUserFilter.index++;
        if (d.complete) {
          const changedRevision = userFilterWireRevision !== d.revision;
          userFilterWireRevision = d.revision; lastUserFilterAt = performance.now(); userFilterSummary = summary;
          if (changedRevision && Number.isFinite(d.detectedAt)) userFilterLatencyMs = Math.max(0, performance.now() - d.detectedAt);
          applyUserFilterRows(pendingUserFilter.items, true); pendingUserFilter = null;
          displayRuleSummary = summary; displayRuleRevision = d.revision;
          displayRules = [...userFilterDecisions.values()]; tickDisplayPlan();
        }
        return;
      }
      if (bilibili && d.type === 'bilibili-experiment-filter') {
        if (!experiment || d.runId !== experiment.runId || d.session !== bridgeScope.session ||
            d.resourceId !== bridgeScope.resourceId || d.epoch !== bridgeScope.epoch ||
            d.sourceGeneration !== sourceGeneration ||
            new TextEncoder().encode(JSON.stringify(d)).length > SOURCE_CHUNK_BYTES) return;
        const update = parseExperimentFilter(d);
        if (!update) return;
        if (!update.ready && experiment.active) { stopExperiment('filter-changed'); return; }
        if (!mirror.filterUpdate(update)) return;
        experiment.filterAt = performance.now();
        recordExperiment(experiment, 'filter-revision', { revision: update.revision, reset: update.reset, ready: update.ready,
          items: update.items.map(item => ({ id: item.id, state: item.state })) });
        if (update.ready) { experiment.nativeReady = true; enableExperimentWhenReady(); }
        return;
      }
      if (d.type === 'sources') {
        if (d.session !== bridgeScope.session || d.resourceId !== bridgeScope.resourceId || d.sourceGeneration !== sourceGeneration || !Number.isSafeInteger(d.revision) || !Number.isSafeInteger(d.index) || d.index < 0 ||
            !Array.isArray(d.upserts) || !Array.isArray(d.removes) || d.upserts.length + d.removes.length > SOURCE_CHUNK_ITEMS ||
            d.removes.some((id: unknown) => typeof id !== 'string' || id.length > 400) || new TextEncoder().encode(JSON.stringify(d)).length > SOURCE_CHUNK_BYTES) return;
        if (d.revision < revision || (d.revision === revision && d.index <= chunkIndex)) { send({ type: 'sources-ack', sourceGeneration, revision: d.revision, index: d.index }); return; }
        if ((d.revision !== revision && d.index !== 0) || (d.revision === revision && d.index !== chunkIndex + 1)) return;
        revision = d.revision; chunkIndex = d.index;
        collectionComplete = !bilibili || d.collectionComplete === true;
        // A finished source snapshot may cover only the segments loaded so far.
        const parsed = parseSources(d.upserts, d.resourceId, bilibili ? 'bilibili' : 'niconico');
        mirror.updateSources(parsed, d.removes, d.reset === true); sourceComplete = d.complete === true;
        const filterRows = bilibili && d.userFilter && Number.isSafeInteger(d.userFilter.revision) &&
          d.userFilter.revision >= userFilterWireRevision ? parseUserFilterRows(d.userFilter.items, SOURCE_CHUNK_ITEMS) : null;
        const validFilterRows = filterRows?.filter(row => parsed.some(source => source.id === row.id && source.originalText === row.originalText));
        if (d.reset === true) userFilterDecisions.clear();
        for (const id of d.removes) userFilterDecisions.delete(id);
        for (const row of validFilterRows ?? []) userFilterDecisions.set(row.id, row);
        scheduler.updateSources(parsed, d.removes, d.reset === true, sourceComplete, bilibili ? {
          epoch: bridgeScope.epoch, revision: ++userFilterAppliedRevision, reset: false,
          items: userFilterEnabled() ? validFilterRows ?? [] : [],
        } : undefined);
        if (sourceComplete) { displaySources = mirror.allSources(); displaySourceRevision = d.revision; tickDisplayPlan(); }
        send({ type: 'sources-ack', sourceGeneration, revision, index: chunkIndex }); publish(); return;
      }
      if (d.type !== 'snapshot') return;
      const c = d.clock;
      if (!c || !['mediaTimeMs', 'durationMs', 'playbackRate'].every(key => typeof c[key] === 'number' && Number.isFinite(c[key])) ||
          c.mediaTimeMs < 0 || c.durationMs <= 0 || c.playbackRate < 0.1 || c.playbackRate > 4 || c.durationMs > 86400000) return;
      const changed = bridgeScope.session !== d.session || bridgeScope.resourceId !== d.resourceId;
      if (!changed && d.epoch < bridgeScope.epoch) return;
      const seeked = bridgeScope.epoch !== d.epoch;
      if (experiment && (changed || seeked || c.seeking === true || (experiment.started && c.paused === true)))
        stopExperiment(changed ? 'resource-changed' : seeked || c.seeking === true ? 'seek' : 'paused');
      bridgeScope = { resourceId: d.resourceId, ...(bilibili ? { urlResourceId: d.urlResourceId } : {}), session: d.session, epoch: d.epoch };
      if (changed) {
        clearUserFilterState();
        scheduler.dispose(); mirror.resetSources(); sourceComplete = false;
        displaySources = []; displaySourceRevision = 0;
        revision = 0; chunkIndex = -1; collectionComplete = !bilibili; sourceGeneration = 0; notice = ''; engineNotice = '';
      }
      if (changed || seeked) { staged = { translated: 0, original: 0 }; plannedReport = null; plannedListReport = null; }
      if (changed) { plannedInputs = 0; plannedProblem = ''; scheduler.configure(normalSchedulerSettings()); }
      if (!changed && seeked) clearUserFilterState();
      if (bilibili) {
        const summary = parseUserFilterSummary(d.userFilterSummary);
        if (summary) userFilterSummary = summary;
        if (d.displayPlanPlayback && typeof d.displayPlanPlayback === 'object') displayPlayback = {
          started: d.displayPlanPlayback.started === true, restored: d.displayPlanPlayback.restored === true,
          seekCount: Number.isSafeInteger(d.displayPlanPlayback.seekCount) && d.displayPlanPlayback.seekCount >= 0 ? d.displayPlanPlayback.seekCount : 0,
          ...(['render-preview', 'live-preview'].includes(d.displayPlanPlayback.owner) ? { owner: d.displayPlanPlayback.owner,
            restoreDisposition: ['pending', 'restored-baseline', 'preserved-external-change'].includes(d.displayPlanPlayback.restoreDisposition)
              ? d.displayPlanPlayback.restoreDisposition : 'pending',
            playbackListeners: d.displayPlanPlayback.playbackListeners === 0 ? 0 : 2 } : {}),
        };
      }
      if (configuredFor !== d.resourceId) { configuredFor = d.resourceId; readSettings(); }
      lastBridge = performance.now(); ready = true; nativeDiagnostic = null;
      const buffered = Array.isArray(c.buffered) ? c.buffered.slice(0, 100).filter((r: any) => Number.isFinite(r?.startMs) && Number.isFinite(r.endMs) && r.startMs >= 0 && r.endMs >= r.startMs && r.endMs <= c.durationMs + 1000) : [];
      const clock: PlaybackClock = { mediaTimeMs: c.mediaTimeMs, durationMs: c.durationMs, playbackRate: c.playbackRate,
        paused: c.paused === true, seeking: c.seeking === true, contentActive: c.contentActive === true, buffered,
        ...(typeof c.commentsVisible === 'boolean' ? { commentsVisible: c.commentsVisible } : {}) };
      if (d.counts) for (const key of ['translated', 'original'] as const) if (Number.isSafeInteger(d.counts[key]) && d.counts[key] >= 0) staged[key] = d.counts[key];
      lastClock = clock;
      if (plannedMode()) {
        if (d.nativeSupply?.report) plannedReport = d.nativeSupply.report;
        if (d.nativeSupply?.ownedRelease) plannedListReport = d.nativeSupply.ownedRelease;
        retirePlannedLegacy();
      } else {
        if (bilibili && settings.bilibiliNativeTranslationOnly && !nativeSupply?.active) nativeSupply?.armSetting();
        nativeSupply?.tick();
      }
      if (experiment && clock.mediaTimeMs >= experiment.toMs) finishExperiment();
      // MAIN may emit the new rule transaction before the clock that announces
      // its epoch. Request it again after adopting that epoch (including cleanup seeks).
      control(bilibili && (changed || seeked) ? { userFilterRefresh: true } : {}); scheduler.snapshot(d.resourceId, d.session,
        experiment && !experiment.active || plannedMode() && document.visibilityState === 'hidden'
          ? { ...clock, contentActive: false } : clock, undefined, d.epoch);
      mirror.setEpoch(d.epoch, changed);
      mirror.observeClock(clock.commentsVisible);
      tickDisplayPlan();
      if (experiment) {
        if (!experiment.started && !clock.paused && !clock.seeking && clock.contentActive && clock.mediaTimeMs < experiment.toMs)
          experiment.playing = true;
        enableExperimentWhenReady();
      }
      publish();
    }
    window.addEventListener('message', receive);
    function userFilterView() {
      const connected = ready && onCurrentPage() && performance.now() - lastBridge < 6000;
      const stale = connected && userFilterEnabled() && performance.now() - lastUserFilterAt > 6500;
      return { connected, stale, featureEnabled: userFilterEnabled(), resourceId: bridgeScope.resourceId,
        summary: connected && !stale ? userFilterSummary : null };
    }
    function tickDisplayPlan() {
      tickRenderPlan();
      tickLivePlan();
      if (!displayPlan?.running || !lastClock) return;
      const contextValid = ready && onCurrentPage() && performance.now() - lastBridge < 6000 &&
        performance.now() - lastUserFilterAt <= 6500 && displayPlanContextValid(displayRuleSummary) &&
        displayRuleSummary?.mainBuildId === BUILD_ID;
      const decisions = new Map(displayRules.map(row => [row.id, row]));
      const complete = sourceComplete && !pendingUserFilter && displayRuleRevision >= 0 &&
        displaySources.every(row => decisions.get(row.id)?.originalText === row.originalText);
      displayPlan.update({ resourceId: bridgeScope.resourceId, epoch: bridgeScope.epoch, clock: lastClock,
        wallTimeMs: performance.now(), sourceRevision: displaySourceRevision, ruleRevision: Math.max(0, displayRuleRevision),
        contextValid, complete, sources: displaySources, decisions: displayRules });
    }
    function renderClock() {
      if (!ready || !lastClock || !onCurrentPage() || performance.now() - lastBridge >= 6000) return null;
      const surface = [...document.querySelectorAll<HTMLElement>('[data-danlingo-player]')]
        .find(element => element.dataset.danlingoPlayer === bridgeScope.session);
      const video = surface?.matches('video') ? surface as HTMLVideoElement : surface?.querySelector<HTMLVideoElement>('video');
      if (!video || !video.isConnected || !Number.isFinite(video.currentTime)) return null;
      return { resourceId: bridgeScope.resourceId, epoch: bridgeScope.epoch, mediaTimeMs: video.currentTime * 1000,
        playbackRate: video.playbackRate ?? lastClock.playbackRate,
        paused: video.paused, seeking: video.seeking, contentActive: !video.ended };
    }
    function tickRenderPlan() {
      if (disposed || !renderPlan?.running || !lastClock || !renderPreview) return;
      const contextValid = ready && onCurrentPage() && performance.now() - lastBridge < 6000 &&
        performance.now() - lastUserFilterAt <= 6500 && displayPlanContextValid(displayRuleSummary) &&
        displayRuleSummary?.mainBuildId === BUILD_ID;
      const decisions = new Map(displayRules.map(row => [row.id, row]));
      const complete = sourceComplete && !pendingUserFilter && displayRuleRevision >= 0 &&
        displaySources.every(row => decisions.get(row.id)?.originalText === row.originalText);
      const clock = renderClock();
      renderPlan.update({ resourceId: bridgeScope.resourceId, epoch: bridgeScope.epoch,
        clock: { ...lastClock, ...(clock ?? {}), contentActive: lastClock.contentActive && !!clock && renderPreview.isVisible() },
        wallTimeMs: performance.now(), sourceRevision: displaySourceRevision, ruleRevision: Math.max(0, displayRuleRevision),
        contextValid, complete, sources: displaySources, decisions: displayRules });
      if (!renderPlan.running) renderPreview.setEnabled(false);
    }
    function liveFrame(): DisplayPlanFrame | null {
      const clock = renderClock();
      if (!lastClock || !clock) return null;
      const contextValid = ready && onCurrentPage() && performance.now() - lastBridge < 6000 &&
        performance.now() - lastUserFilterAt <= 6500 && displayPlanContextValid(displayRuleSummary) &&
        displayRuleSummary?.mainBuildId === BUILD_ID;
      const decisions = new Map(displayRules.map(row => [row.id, row]));
      return { resourceId: bridgeScope.resourceId, epoch: bridgeScope.epoch,
        clock: { ...lastClock, ...clock, contentActive: lastClock.contentActive && clock.contentActive === true && !clock.paused &&
          document.visibilityState !== 'hidden' && renderPreview?.isVisible() === true },
        wallTimeMs: performance.now(), sourceRevision: displaySourceRevision, ruleRevision: Math.max(0, displayRuleRevision),
        contextValid, complete: sourceComplete && !pendingUserFilter && displayRuleRevision >= 0 &&
          displaySources.every(row => decisions.get(row.id)?.originalText === row.originalText),
        sources: displaySources, decisions: displayRules };
    }
    function liveRecord(event: string, details: Record<string, unknown> = {}) {
      if (livePageEvents.length < 10000) livePageEvents.push({ event, atMs: performance.now(),
        mediaTimeMs: renderClock()?.mediaTimeMs ?? null, ...details });
    }
    async function liveHost(action: string, args: Record<string, unknown> = {}) {
      const response = await browser.runtime.sendMessage({ type: 'bilibili-live-preview-host', action,
        runId: liveGrant?.runId, instanceId: liveGrant?.instanceId, session: resourceSession(), ...args });
      if (!response?.ok) throw new Error(response?.error ?? 'live-preview-background-unavailable');
      return response;
    }
    function updateLiveUi() {
      if (!renderPreview) return;
      const report = renderPreview.report(), budget = liveBackground?.budget;
      const phase = budget?.phases?.[liveGrant?.phase ?? 'main'];
      const remaining = phase?.remaining;
      const rows = report.records;
      renderPreview.setLiveState({ status: liveState as any,
        modelName: liveBackground?.localState?.modelName ?? liveGrant?.modelName ?? liveGrant?.modelAfterLoad?.model?.name ?? liveGrant?.modelId ?? null,
        modelState: liveBackground?.localState?.phase ?? liveGrant?.modelAfterLoad?.phase ?? 'unprepared', targetLanguage: 'ja',
        remaining: { requests: remaining?.requests ?? 0, items: remaining?.items ?? 0, chars: remaining?.utf16Chars ?? 0 },
        sent: phase?.actualSent?.requests ?? 0, ready: liveResults.size,
        adopted: rows.filter(row => row.origin === 'live-local' && row.renderSubmittedAtWallMs !== null).length,
        fallback: rows.filter(row => row.sourceMode === 'original').length, reason: liveReason || null });
    }
    async function refreshLiveState() {
      if (liveStatusPending) return;
      liveStatusPending = true;
      try {
        liveBackground = await liveHost('status'); liveStatusAt = performance.now();
        const grant = liveBackground.grant;
        if (grant && sameSession(grant.session, resourceSession()) && grant.buildId === BUILD_ID) {
          if (!liveGrant || liveGrant.instanceId === grant.instanceId) liveGrant = grant;
          if (grant.state === 'recovery-required') { stopLiveSupply('recovery-required'); liveState = 'stopped'; }
        }
        updateLiveUi();
      } catch (error) { liveReason = error instanceof Error ? error.message : 'live-preview-status-failed'; updateLiveUi(); }
      finally { liveStatusPending = false; }
    }
    function feedLivePreview(snapshot: { events: DisplayPlanEvent[] }, frame: DisplayPlanFrame) {
      const sources = new Map(frame.sources.map(row => [row.id, row]));
      const decisions = new Map(frame.decisions.map(row => [row.id, row]));
      const events = snapshot.events.filter(event => event.epoch === frame.epoch);
      const eligibilityById = Object.fromEntries(events.map(event => {
        const source = sources.get(event.id), decision = decisions.get(event.id);
        return [event.id, source?.originalText !== event.originalText ? 'exclude'
          : decision?.originalText === event.originalText ? decision.state : 'unknown'];
      })) as Record<string, 'exclude' | 'retain' | 'unknown'>;
      return renderPreview?.feed({ resourceId: frame.resourceId, epoch: frame.epoch, contextValid: frame.contextValid,
        targetLanguage: 'ja', events, eligibilityById, existingTranslations: [...liveResults.values()],
        ...(liveGrant ? { liveIdentity: { runId: liveGrant.runId, configIdentity: liveGrant.configIdentity } } : {}) }) ?? [];
    }
    function liveSendable(event: DisplayPlanEvent) {
      if (!liveGrant || !['running', 'paused'].includes(liveState) || !liveOwnsOverride || settings.enabled ||
          bridgeScope.epoch !== liveGrant.epoch || !sameSession(liveGrant.session, resourceSession())) return false;
      const clock = renderClock(), decision = userFilterDecisions.get(event.id);
      if (!clock || clock.paused || clock.seeking || document.visibilityState === 'hidden' ||
          !renderPreview?.isVisible() || performance.now() - lastUserFilterAt > 6500 ||
          !displayPlanContextValid(displayRuleSummary) || displayRuleSummary?.mainBuildId !== BUILD_ID ||
          decision?.originalText !== event.originalText || decision.state === 'exclude') return false;
      const record = renderPreview.report().records.find(row => row.id === event.id && row.epoch === event.epoch &&
        row.resourceId === event.resourceId && row.sourceId === event.sourceId);
      return record?.state === 'reserved' && record.textLockedAtWallMs === null;
    }
    function acceptLiveResult(output: LivePlanOutput, event: DisplayPlanEvent) {
      const meta = output.preview, clock = renderClock();
      if (!meta || !clock || !liveGrant || !['running', 'paused'].includes(liveState) ||
          meta.runId !== liveGrant.runId || meta.instanceId !== liveGrant.instanceId ||
          meta.configIdentity !== liveGrant.configIdentity || meta.originalText !== event.originalText ||
          event.epoch !== liveGrant.epoch || event.resourceId !== liveGrant.session.resourceId ||
          !['translated', 'cached'].includes(output.status) || typeof output.text !== 'string' || !output.text.trim()) return;
      const key = JSON.stringify([event.resourceId, event.epoch, event.id]);
      if (liveResults.has(key)) return;
      const result: RenderExistingTranslation = { resourceId: event.resourceId, epoch: event.epoch, id: event.id,
        sourceId: event.sourceId, originalText: event.originalText, targetLanguage: 'ja', text: output.text,
        availableAtWallMs: performance.now(), availableAtMediaMs: clock.mediaTimeMs,
        origin: 'live-local', runId: meta.runId, requestId: meta.requestId, resultId: meta.resultId,
        configIdentity: meta.configIdentity };
      liveResults.set(key, result);
      liveRecord('previewReady', { id: event.id, sourceId: event.sourceId, epoch: event.epoch,
        t0: event.mediaTimeMs, requestId: meta.requestId, taskId: meta.taskId, resultId: meta.resultId, kind: meta.kind });
      const frame = liveFrame();
      if (frame && livePlan) feedLivePreview((livePlan.report(true) as any).B, frame);
      updateLiveUi();
    }
    function createLivePlan() {
      return new DisplayPlanSession(settings, { comparison: false, now: performance.now(),
        range: { startMs: liveGrant.fromMs, endMs: liveGrant.toMs },
        getCurrentClock: () => { const frame = liveFrame(); return frame?.clock ?? null; },
        getSendable: event => liveSendable(event),
        canRequest: event => !!liveGrant && event.mediaTimeMs >= liveGrant.fromMs && event.mediaTimeMs < liveGrant.toMs,
        beforeDispatch: feedLivePreview,
        live: {
          translate: async ({ resourceId, epoch, requestId, items, signal, onResult }) => {
            if (signal.aborted) return [];
            const grant = liveGrant;
            const cancel = () => { void liveHost('cancel', { runId: grant.runId, instanceId: grant.instanceId, requestId }).catch(() => {}); };
            liveRequests.set(requestId, { signal, onResult }); signal.addEventListener('abort', cancel, { once: true });
            try {
              const response = await liveHost('translate', { runId: grant.runId, instanceId: grant.instanceId,
                resourceId, epoch, requestId, items });
              return signal.aborted || liveGrant?.instanceId !== grant.instanceId ? [] : response.items ?? [];
            } catch (error) {
              liveRecord('request-rejected', { requestId, reason: error instanceof Error ? error.message : 'request-failed' });
              return items.map(item => ({ id: item.id, status: 'failed' as const, reason: 'live-preview-request-rejected' }));
            } finally { signal.removeEventListener('abort', cancel); liveRequests.delete(requestId); }
          },
          cancelItems: (requestId, ids) => { void liveHost('cancel', { requestId, ids }).catch(() => {}); },
          onReady: acceptLiveResult,
        },
      });
    }
    function liveSnapshot(includeText = false) {
      return { coverage: userFilterSummary, plan: livePlan?.report(includeText) ?? null,
        render: renderPreview?.report(includeText) ?? null, clock: renderClock(), playback: { ...displayPlayback },
        pageEvents: [...livePageEvents], state: liveState, reason: liveReason || null,
        runId: liveGrant?.runId ?? null, instanceId: liveGrant?.instanceId ?? null,
        restored: !liveOwnsOverride && displayPlayback.restored && userFilterSummary?.featureEnabled === userFilterEnabled(),
        nativePrepared: staged.translated, adapterPrepared: staged.translated, nativeSettingsWrites: 0 };
    }
    function liveCutoffs(includeText: boolean) {
      const pick = (value: any) => value ? includeText ? value.full : value.summary : null;
      return { mainCutoff: pick(liveMainCutoff), tailCutoff: pick(liveTailCutoff) };
    }
    function stopLiveSupply(reason: string) {
      if (!liveOwnsOverride || !['running', 'paused', 'ready'].includes(liveState)) return;
      liveState = 'draining'; liveReason = reason;
      livePlan?.stopSupply(reason); liveRecord('supply-stopped', { reason });
      liveMainCutoff ??= { summary: liveSnapshot(), full: liveSnapshot(true) };
      void liveHost('drain', { reason }).then(value => { liveBackground = value; updateLiveUi(); })
        .catch(error => { liveReason = error.message; updateLiveUi(); });
      updateLiveUi();
    }
    function tickLivePlan() {
      if (disposed || !liveOwnsOverride || !livePlan || !liveGrant) return;
      const frame = liveFrame();
      if (!frame) { stopLiveSupply('native-unavailable'); return; }
      if (frame.epoch !== liveGrant.epoch || !sameSession(resourceSession(), liveGrant.session) || !frame.contextValid) {
        stopLiveSupply('context-changed'); livePlan.stop('context-changed');
        renderPreview?.cleanup(); liveState = 'stopped'; return;
      }
      if (frame.clock.mediaTimeMs >= liveGrant.toMs) stopLiveSupply('range-complete');
      if (!livePlaybackStarted && ['running', 'paused'].includes(liveState)) {
        if (frame.clock.paused || frame.clock.seeking) return;
        livePlaybackStarted = true;
      }
      if (['running', 'paused'].includes(liveState)) {
        liveState = frame.clock.paused || !frame.clock.contentActive ? 'paused' : 'running';
        liveReason = liveState === 'paused' ? frame.clock.paused ? 'paused' : 'preview-hidden' : '';
      }
      livePlan.update(frame);
      if (liveState === 'draining' && frame.clock.mediaTimeMs >= Math.min(liveGrant.toMs + 18000, 103000)) {
        liveTailCutoff ??= { summary: liveSnapshot(), full: liveSnapshot(true) }; liveState = 'stopped';
        liveRecord('tail-complete');
      }
      if (performance.now() - liveStatusAt > 1500) void refreshLiveState();
      updateLiveUi();
    }
    async function livePreviewAction(action: string, input: any = {}) {
      if (['status', 'export'].includes(action)) return { ok: true, version: browser.runtime.getManifest().version, buildId: BUILD_ID, session: resourceSession(),
        epoch: bridgeScope.epoch, report: liveSnapshot(action === 'export'),
        ...liveCutoffs(action === 'export') };
      if (liveBusy) throw new Error('live-preview-control-busy');
      liveBusy = true;
      try {
        if (action === 'prepare') {
          if (!ready || !lastClock || !renderPreview || !onCurrentPage() || experiment || displayPlanOwnsOverride ||
              renderOwnsOverride || settings.enabled || userFilterOverride !== null && !liveOwnsOverride)
            throw new Error('live-preview-watch-not-ready-or-other-experiment');
          if (!liveOwnsOverride) { livePriorOverride = userFilterOverride; userFilterOverride = true; liveOwnsOverride = true; }
          scheduler.configure({ ...settings, enabled: false }); scheduler.dispose();
          liveMode = true; liveState = 'unprepared'; liveReason = '';
          renderPreview.setMode('live-local'); renderPreview.setEnabled(true); renderPreview.reveal();
          const requestedAt = performance.now(), fromMs = input.fromMs ?? 45000;
          control({ displayPlanPlayback: 'prepare-live', displayPlanOwner: 'live-preview', livePreviewFromMs: fromMs, userFilterRefresh: true });
          for (let attempt = 0; attempt < 80; attempt++) {
            const clock = renderClock();
            if (clock?.paused && !clock.seeking && Math.abs(clock.mediaTimeMs - fromMs) < 250 &&
                lastUserFilterAt >= requestedAt && liveFrame()?.contextValid && displayPlayback.owner === 'live-preview') break;
            if (attempt === 79) throw new Error('live-preview-prepare-playback-unconfirmed');
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          const opened = await browser.runtime.sendMessage({ type: 'session-open', session: resourceSession() });
          if (!opened?.ok) throw new Error('live-preview-session-open-failed');
          const frame = liveFrame(); if (frame) feedLivePreview({ events: [] }, frame);
          liveRecord('prepared-page');
        } else if (action === 'bind') {
          const response = await liveHost('status'), grant = response.grant;
          if (!liveOwnsOverride || !grant || grant.state !== 'prepared' || grant.epoch !== bridgeScope.epoch ||
              grant.buildId !== BUILD_ID || !sameSession(grant.session, resourceSession())) throw new Error('live-preview-grant-mismatch');
          liveBackground = response; liveGrant = grant; liveState = 'ready'; liveReason = '';
          liveResults.clear(); liveMainCutoff = liveTailCutoff = null;
          renderPreview?.setMode('live-local'); renderPreview?.setEnabled(true); renderPreview?.reveal();
          const frame = liveFrame(); if (frame) feedLivePreview({ events: [] }, frame);
        } else if (action === 'start') {
          if (!liveGrant || liveState !== 'ready' || !liveOwnsOverride || !liveFrame()?.contextValid ||
              renderClock()?.paused !== true) throw new Error('live-preview-prepare-required');
          // Tab activation precedes IntersectionObserver and visibility delivery.
          // Waiting here never starts the planner or sends a model request.
          for (let attempt = 0; attempt < 30 && !renderPreview?.isVisible(); attempt++)
            await new Promise(resolve => setTimeout(resolve, 100));
          if (!renderPreview?.isVisible() || !liveFrame()?.contextValid || renderClock()?.paused !== true)
            throw new Error('live-preview-not-visible');
          liveBackground = await liveHost('start');
          livePlan = createLivePlan(); livePlaybackStarted = false; liveState = 'running'; liveReason = '';
          liveRecord('start'); control({ displayPlanPlayback: 'play' });
          // Planning starts only after the actual media clock confirms natural playback.
        } else if (action === 'drain' || action === 'stop') {
          stopLiveSupply(input.reason ?? 'manual-stop');
          liveBackground = await liveHost('drain', { reason: input.reason ?? 'manual-stop' });
        } else if (action === 'cleanup') {
          if (liveGrant) liveBackground = await liveHost('stop', { reason: 'cleanup' });
          livePlan?.stop('cleanup'); renderPreview?.cleanup();
          liveState = 'stopped';
          if (liveOwnsOverride) {
            userFilterOverride = livePriorOverride;
            const requestedAt = performance.now(); control({ displayPlanPlayback: 'restore', userFilterRefresh: true });
            for (let attempt = 0; attempt < 80 && (lastUserFilterAt < requestedAt || !displayPlayback.restored ||
                userFilterSummary?.featureEnabled !== userFilterEnabled()); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
            if (lastUserFilterAt < requestedAt || !displayPlayback.restored || userFilterSummary?.featureEnabled !== userFilterEnabled())
              throw new Error('live-preview-restore-unconfirmed');
            liveOwnsOverride = false;
          }
          liveRecord('cleanup');
        } else throw new Error('live-preview-invalid-action');
        updateLiveUi(); publish(true);
        return { ok: true, version: browser.runtime.getManifest().version, buildId: BUILD_ID, session: resourceSession(), epoch: bridgeScope.epoch,
          report: liveSnapshot(), ...liveCutoffs(false) };
      } catch (error) { liveReason = error instanceof Error ? error.message : 'live-preview-failed'; updateLiveUi(); throw error; }
      finally { liveBusy = false; }
    }
    async function renderPreviewAction(action: string) {
      if (renderBusy) throw new Error('render-preview-control-busy');
      renderBusy = true;
      try {
        if (!ready || !lastClock || !onCurrentPage() || performance.now() - lastBridge >= 6000 || experiment ||
            displayPlanOwnsOverride || !renderPreview || settings.enabled && !['cleanup', 'status', 'export'].includes(action))
          throw new Error('render-preview-watch-not-ready-or-translation-enabled');
        if (action === 'run' && !renderPlan?.running) {
          const guard = await browser.runtime.sendMessage({ type: 'bilibili-render-preview-guard', action: 'status', session: resourceSession() });
          if (!guard?.ok || !guard.zeroModelGuard || guard.buildId !== BUILD_ID) throw new Error('render-preview-guard-required');
          if (userFilterOverride !== null) throw new Error('render-preview-other-experiment-active');
          if (renderPlan) renderPlan.resume(settings);
          else renderPlan = new DisplayPlanSession(settings, { comparison: false, now: performance.now(),
            beforeDispatch: (snapshot, frame) => {
              const sources = new Map(frame.sources.map(row => [row.id, row]));
              const decisions = new Map(frame.decisions.map(row => [row.id, row]));
              const eligibilityById = Object.fromEntries(snapshot.events.filter(event => event.epoch === frame.epoch).map(event => {
                const source = sources.get(event.id), decision = decisions.get(event.id);
                return [event.id, source?.originalText !== event.originalText ? 'exclude'
                  : decision?.originalText === event.originalText ? decision.state : 'unknown'];
              })) as Record<string, 'exclude' | 'retain' | 'unknown'>;
              return renderPreview?.feed({ resourceId: frame.resourceId, epoch: frame.epoch, contextValid: frame.contextValid,
                targetLanguage: settings.targetLanguage, events: snapshot.events.filter(event => event.epoch === frame.epoch),
                eligibilityById }) ?? [];
            },
          });
          renderPriorOverride = userFilterOverride; userFilterOverride = true; renderOwnsOverride = true; renderError = '';
          renderPreview.setEnabled(true); publish(true); renderPreview.reveal();
          tickRenderPlan(); control({ userFilterRefresh: true, displayPlanPlayback: 'start', displayPlanOwner: 'render-preview' });
        } else if (action === 'pause' || action === 'play') {
          if (!renderPlan?.running) throw new Error('render-preview-not-running');
          const paused = action === 'pause';
          control({ displayPlanPlayback: action });
          for (let attempt = 0; attempt < 60 && renderClock()?.paused !== paused; attempt++)
            await new Promise(resolve => setTimeout(resolve, 100));
          if (renderClock()?.paused !== paused) throw new Error('render-preview-playback-unconfirmed');
        } else if (action === 'seek') {
          if (!renderPlan?.running) throw new Error('render-preview-not-running');
          const prior = bridgeScope.epoch;
          control({ displayPlanPlayback: 'seek', userFilterRefresh: true });
          for (let attempt = 0; attempt < 60 && (bridgeScope.epoch === prior || lastClock.seeking); attempt++)
            await new Promise(resolve => setTimeout(resolve, 100));
          if (bridgeScope.epoch === prior || lastClock.seeking) throw new Error('render-preview-seek-not-confirmed');
        } else if (action === 'cleanup') {
          renderPlan?.stop('cleanup'); renderPreview.cleanup();
          userFilterOverride = renderOwnsOverride ? renderPriorOverride : userFilterOverride;
          const requestedAt = performance.now(); control({ displayPlanPlayback: 'restore', userFilterRefresh: true });
          for (let attempt = 0; attempt < 60 && (lastUserFilterAt < requestedAt || !displayPlayback.restored ||
              userFilterSummary?.featureEnabled !== userFilterEnabled()); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
          if (lastUserFilterAt < requestedAt || !displayPlayback.restored || userFilterSummary?.featureEnabled !== userFilterEnabled())
            throw new Error('render-preview-restore-unconfirmed');
          renderOwnsOverride = false;
        }
        tickRenderPlan(); publish(true);
        return { ok: true, version: browser.runtime.getManifest().version, buildId: BUILD_ID, session: resourceSession(),
          enabled: !!renderPlan?.running, report: { coverage: userFilterSummary,
            simulation: renderPlan?.report(action === 'export') ?? null, render: renderPreview.report(action === 'export'),
            clock: renderClock(), playback: displayPlayback, error: renderError || undefined,
            restored: !renderPlan?.running && displayPlayback.restored && !renderOwnsOverride &&
              userFilterSummary?.featureEnabled === userFilterEnabled(), actualModelCalls: 0, modelLoads: 0,
            nativeSettingsWrites: 0, adapterPrepared: 0 } };
      } finally { renderBusy = false; }
    }
    async function displayPlanAction(action: string) {
      if (displayPlanBusy) throw new Error('display-plan-control-busy');
      displayPlanBusy = true;
      try {
        if (!ready || !lastClock || !onCurrentPage() || performance.now() - lastBridge >= 6000 || experiment ||
            renderOwnsOverride || settings.enabled && !['cleanup', 'status', 'export'].includes(action))
          throw new Error('display-plan-watch-not-ready-or-translation-enabled');
        if (action === 'run' && (!displayPlan || !displayPlan.running)) {
          const guard = await browser.runtime.sendMessage({ type: 'bilibili-display-plan-guard', action: 'status', session: resourceSession() });
          if (!guard?.ok || !guard.zeroModelGuard || guard.buildId !== BUILD_ID) throw new Error('display-plan-guard-required');
          if (userFilterOverride !== null) throw new Error('display-plan-other-experiment-active');
          if (displayPlan) displayPlan.resume(settings);
          else displayPlan = new DisplayPlanSession(settings, { now: performance.now() });
          displayPlanPriorOverride = userFilterOverride; userFilterOverride = true; displayPlanOwnsOverride = true;
          displayPlanError = '';
          tickDisplayPlan(); control({ userFilterRefresh: true, displayPlanPlayback: 'start' });
        } else if (action === 'seek') {
          if (!displayPlan || !displayPlan.running) throw new Error('display-plan-not-running');
          const prior = bridgeScope.epoch;
          control({ displayPlanPlayback: 'seek', userFilterRefresh: true });
          for (let attempt = 0; attempt < 60 && (bridgeScope.epoch === prior || lastClock.seeking); attempt++)
            await new Promise(resolve => setTimeout(resolve, 100));
          if (bridgeScope.epoch === prior || lastClock.seeking) throw new Error('display-plan-seek-not-confirmed');
        } else if (action === 'cleanup') {
          displayPlan?.stop('cleanup'); userFilterOverride = displayPlanPriorOverride;
          const requestedAt = performance.now(); control({ displayPlanPlayback: 'restore', userFilterRefresh: true });
          for (let attempt = 0; attempt < 60 && (lastUserFilterAt < requestedAt || !displayPlayback.restored ||
              userFilterSummary?.featureEnabled !== userFilterEnabled()); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
          if (lastUserFilterAt < requestedAt || !displayPlayback.restored || userFilterSummary?.featureEnabled !== userFilterEnabled())
            throw new Error('display-plan-restore-unconfirmed');
          displayPlanOwnsOverride = false;
        }
        tickDisplayPlan(); publish(true);
        return { ok: true, version: browser.runtime.getManifest().version, buildId: BUILD_ID, session: resourceSession(),
          enabled: !!displayPlan && displayPlan.running, report: { coverage: userFilterSummary,
            simulation: displayPlan?.report(action === 'export') ?? null, playback: displayPlayback,
            restored: (!displayPlan || !displayPlan.running) && displayPlayback.restored &&
              userFilterOverride === displayPlanPriorOverride && userFilterSummary?.featureEnabled === userFilterEnabled(),
            actualModelCalls: 0, modelLoads: 0, nativeSettingsWrites: 0 } };
      } finally { displayPlanBusy = false; }
    }
    const listener = (message: any, sender: { id?: string; tab?: unknown }) => {
      if (sender.id !== browser.runtime.id || sender.tab !== undefined) return;
      if (bilibili && message?.type === 'bilibili-native-supply-proof') return Promise.resolve(nativeSupply?.proof(message));
      if (bilibili && message?.type === 'bilibili-native-supply-result') {
        nativeSupply?.acceptResult(message.requestId, message.output); return Promise.resolve({ ok: true });
      }
      if (bilibili && message?.type === 'bilibili-native-supply' && plannedMode())
        return Promise.resolve(['status', 'export'].includes(message.action) ? {
          ok: true, mode: 'planned', version: browser.runtime.getManifest().version, buildId: BUILD_ID,
          state: plannedStatus().state, reason: plannedStatus().reason,
          report: plannedReport, ownedRelease: plannedListReport, submittedInputs: plannedInputs,
          ...(settings.bilibiliHybrid?.enabled ? { hybridStats, hybridStatsScope: 'background-worker-all-tabs' } : {}),
        } : { ok: false, error: 'planned-use-ordinary-translation-controls' });
      if (bilibili && message?.type === 'bilibili-native-supply')
        return nativeSupply?.action(message.action, message.input ?? message).then(reply => ({ ...reply, version: browser.runtime.getManifest().version,
          coverage: userFilterSummary, ruleRevision: userFilterWireRevision, sourceComplete, sourceCount: mirror.allSources().length
        })).catch(error => ({ ok: false, error: error.message }));
      if (bilibili && message?.type === 'bilibili-live-preview-proof') {
        const frame = liveFrame();
        return Promise.resolve({ ok: !!liveGrant && message.runId === liveGrant.runId &&
          message.instanceId === liveGrant.instanceId && message.epoch === bridgeScope.epoch,
          buildId: BUILD_ID, runId: liveGrant?.runId, instanceId: liveGrant?.instanceId,
          epoch: bridgeScope.epoch, session: resourceSession(), contextValid: frame?.contextValid === true,
          visible: document.visibilityState !== 'hidden' && renderPreview?.isVisible() === true,
          clock: frame?.clock ?? null, demands: livePlan?.currentDemand() ?? [] });
      }
      if (bilibili && message?.type === 'bilibili-live-preview-result') {
        const request = liveRequests.get(message.requestId);
        if (request && !request.signal.aborted && liveGrant?.runId === message.runId &&
            liveGrant?.instanceId === message.instanceId) request.onResult(message.output);
        return Promise.resolve({ ok: true });
      }
      if (bilibili && message?.type === 'bilibili-live-preview' &&
          ['prepare', 'bind', 'start', 'status', 'export', 'stop', 'drain', 'cleanup'].includes(message.action))
        return livePreviewAction(message.action, message.input ?? message).catch(error => ({ ok: false, error: error.message }));
      if (bilibili && message?.type === 'bilibili-render-preview-control' &&
          ['prepare', 'run', 'status', 'pause', 'play', 'seek', 'export', 'cleanup'].includes(message.action))
        return renderPreviewAction(message.action).catch(error => ({ ok: false, error: error.message }));
      if (bilibili && message?.type === 'bilibili-display-plan-control' &&
          ['prepare', 'run', 'status', 'seek', 'export', 'cleanup'].includes(message.action))
        return displayPlanAction(message.action).catch(error => ({ ok: false, error: error.message }));
      if (bilibili && message?.type === 'get-bilibili-user-filter-status')
        return Promise.resolve({ ok: true, session: resourceSession(), view: userFilterView() });
      if (bilibili && message?.type === 'bilibili-user-filters-control' &&
          ['prepare', 'run', 'status', 'cleanup'].includes(message.action)) return (async () => {
        if (!ready || !lastClock || !onCurrentPage() || performance.now() - lastBridge >= 6000 || experiment || displayPlan && displayPlan.running || renderOwnsOverride || liveOwnsOverride)
          return { ok: false, error: 'user-filter-watch-not-ready' };
        if (message.action === 'prepare' || message.action === 'run' || message.action === 'cleanup') {
          userFilterOverride = message.action === 'cleanup' ? null : message.action === 'run';
          const requestedAt = performance.now(); control({ userFilterRefresh: true,
            ...(message.action === 'cleanup' ? { userFilterObserve: 'restore' } : {}) });
          for (let attempt = 0; attempt < 50 && (lastUserFilterAt < requestedAt ||
            userFilterSummary?.featureEnabled !== userFilterEnabled()); attempt++)
            await new Promise(resolve => setTimeout(resolve, 100));
          if (lastUserFilterAt < requestedAt || userFilterSummary?.featureEnabled !== userFilterEnabled())
            return { ok: false, error: 'user-filter-native-ack-timeout' };
        }
        if (message.action === 'run') {
          const observeAt = performance.now();
          control({ userFilterObserve: 'start' });
          // Wait for a bounded, naturally published playback snapshot; never drive native filters.
          for (let attempt = 0; attempt < 50 && (!userFilterSummary?.observation?.started ||
            lastClock?.seeking || lastUserFilterAt < observeAt); attempt++)
            await new Promise(resolve => setTimeout(resolve, 100));
          userFilterSimulation = await simulateUserFilterDemand({
            sources: mirror.allSources(), settings, clock: lastClock!, epoch: bridgeScope.epoch,
            decisions: [...userFilterDecisions.values()], normalEligibility: mirror.currentEligibility(),
          });
        }
        const restored = userFilterOverride === null && userFilterSummary?.featureEnabled === settings.bilibiliUserFilters &&
          (settings.bilibiliUserFilters || userFilterSummary?.restored === true) &&
          userFilterSummary?.observation?.restored !== false;
        return { ok: true, version: browser.runtime.getManifest().version, buildId: BUILD_ID,
          session: resourceSession(), enabled: userFilterEnabled(), report: {
            coverage: userFilterSummary, applyLatencyMs: userFilterLatencyMs, propagationWindowMs: 2500,
            candidateEvents: mirror.allSources().length, simulation: userFilterSimulation,
            restored, actualModelCalls: 0, nativeSettingsWrites: 0, modelLoads: 0,
          } };
      })();
      if (bilibili && message?.type === 'bilibili-experiment-preview') {
        if (!validExperimentRange(message) || !ready || !onCurrentPage() || !validSession(resourceSession()) ||
            performance.now() - lastBridge >= 6000) return Promise.resolve({ ok: false, error: 'watch-not-ready' });
        return Promise.resolve({ ok: true, version: browser.runtime.getManifest().version, buildId: BUILD_ID,
          session: resourceSession(), resourceId: bridgeScope.resourceId,
          effectiveBatchLimit: videoBatchLimit(settings),
          items: mirror.preview(message, settings.sourceLanguage, settings.targetLanguage) });
      }
      if (bilibili && message?.type === 'bilibili-experiment-configure') {
        const command = message as ExperimentRange & { runId: string; configVersion: number; filterEnabled: boolean; singleDispatch?: boolean };
        if (!ready || !onCurrentPage() || !validSession(resourceSession()) || performance.now() - lastBridge >= 6000 ||
            !validExperimentRange(command) || typeof command.runId !== 'string' ||
            !/^[a-zA-Z0-9-]{1,100}$/.test(command.runId) ||
            command.configVersion !== configVersion || typeof command.filterEnabled !== 'boolean' ||
            (command.singleDispatch !== undefined && typeof command.singleDispatch !== 'boolean') || experiment)
          return Promise.resolve({ ok: false, error: 'experiment-not-ready' });
        experiment = { runId: command.runId, configVersion, fromMs: command.fromMs, toMs: command.toMs,
          prefetchSeconds: command.prefetchSeconds, filterEnabled: command.filterEnabled,
          singleDispatch: command.singleDispatch === true,
          nativeReady: false, playing: false, started: false, active: false, ended: false, filterAt: performance.now() };
        scheduler.dispose();
        scheduler.configure(experimentSettings(true));
        scheduler.snapshot(bridgeScope.resourceId, bridgeScope.session,
          { ...lastClock!, contentActive: false }, undefined, bridgeScope.epoch);
        scheduler.updateSources(mirror.allSources(), [], true, sourceComplete);
        mirror.clearFilter();
        experimentControl(experiment, true);
        publish(true);
        const effective = experimentSettings(true);
        return Promise.resolve({ ok: true, version: browser.runtime.getManifest().version, buildId: BUILD_ID,
          effectiveBatchLimit: videoBatchLimit(effective), concurrency: effective.concurrency,
          singleDispatch: experiment.singleDispatch, session: resourceSession() });
      }
      if (bilibili && message?.type === 'bilibili-experiment-stop') {
        if (!experiment || message.runId !== experiment.runId) return Promise.resolve({ ok: false, error: 'run-mismatch' });
        stopExperiment('stopped', false);
        return Promise.resolve({ ok: true });
      }
      if (message?.type === 'video-translation-result' || message?.type === 'bilibili-experiment-result') {
        const request = videoRequests.get(message.requestId);
        const output = message.output;
        if (!request || request.signal.aborted || !isCurrent(request.scope) || message.resourceId !== request.scope.resourceId ||
            request.configVersion < 0 || message.configVersion !== request.configVersion || configVersion !== request.configVersion ||
            (request.runId ? message.type !== 'bilibili-experiment-result' || message.runId !== request.runId ||
              experiment?.runId !== request.runId || experiment.ended : message.type !== 'video-translation-result') ||
            (bilibili && !sameSession(resourceSession(), message.session ?? (request.runId ? null : resourceSession()))) ||
            !output || !request.ids.has(output.id) || !['translated', 'cached'].includes(output.status) ||
            typeof output.text !== 'string' || !output.text.trim() || output.text.length > 2000) return;
        if (request.runId && experiment) recordExperiment(experiment, 'item-result', { requestId: message.requestId,
          id: output.id, status: output.status, text: output.text });
        request.receive({ id: output.id, text: output.text, status: output.status,
          ...(['local', 'online'].includes(output.backend) ? { backend: output.backend } : {}) });
        return;
      }
      if (bilibili && (message?.type === 'get-adapter-diagnostic' || message?.type === 'verify-adapter-diagnostic')) {
        const diagnostic = currentDiagnostic();
        if (!diagnostic || message.urlResourceId !== diagnostic.urlResourceId || typeof message.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(message.requestId)) return Promise.resolve({ ok: false });
        if (message.type === 'verify-adapter-diagnostic') return Promise.resolve({ ok: message.documentSession === documentSession &&
          JSON.stringify(parseAdapterDiagnostic(message.diagnostic, diagnostic.urlResourceId)) === JSON.stringify(diagnostic) });
        return Promise.resolve({ ok: true, requestId: message.requestId, documentSession, diagnostic });
      }
      if (bilibili && message?.type === 'verify-resource-session') return Promise.resolve({ ok: ready && onCurrentPage() && sameSession(resourceSession(), message.session) && performance.now() - lastBridge < 6000 });
      if (message?.type === 'settings-updated') { settingsRead++; applySettings(message); }
    };
    browser.runtime.onMessage.addListener(listener); readSettings();
    const timer = ctx.setInterval(() => {
      if (bilibili && lastUserFilterAt !== -Infinity && performance.now() - lastUserFilterAt > 6500) {
        applyUserFilterRows([], true); lastUserFilterAt = -Infinity; userFilterSummary = null; pendingUserFilter = null;
      }
      if (experiment && performance.now() - experiment.filterAt > 1500) stopExperiment('filter-lease-expired');
      if (performance.now() - lastBridge > 6000) { if (bilibili) { stopExperiment('native-unavailable'); loseNative(plannedMode()); } else ready = false; }
      else { control(); scheduler.tick(); }
      tickDisplayPlan();
      if (plannedMode()) retirePlannedLegacy(); else nativeSupply?.tick();
      publish();
    }, 500);
    const visibilityChanged = () => {
      if (!plannedMode()) return;
      scheduler.configure(normalSchedulerSettings());
      if (lastClock && ready) scheduler.snapshot(bridgeScope.resourceId, bridgeScope.session,
        { ...lastClock, contentActive: lastClock.contentActive && document.visibilityState !== 'hidden' }, undefined, bridgeScope.epoch);
      control(); publish(true);
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    ctx.onInvalidated(() => {
      if (plannedMode()) void nativeSupply?.retire().catch(() => {});
      else nativeSupply?.pause('invalidated');
      stopLiveSupply('invalidated'); livePlan?.stop('invalidated');
      stopExperiment('invalidated');
      displayPlan?.stop('invalidated');
      renderPlan?.stop('invalidated'); renderPreview?.dispose();
      if (displayPlanOwnsOverride) { userFilterOverride = displayPlanPriorOverride; control({ displayPlanPlayback: 'restore', userFilterRefresh: true }); }
      if (renderOwnsOverride) { userFilterOverride = renderPriorOverride; control({ displayPlanPlayback: 'restore', userFilterRefresh: true }); }
      disposed = true; settings.enabled = false; control(); scheduler.dispose(); clearInterval(timer); progress.dispose();
      disabledNotice?.remove(); progressHost?.style.removeProperty('display');
      fullscreenToggle?.dispose();
      if (progressHost) document.removeEventListener('fullscreenchange', updateDisabledPresentation);
      window.removeEventListener('message', receive); browser.runtime.onMessage.removeListener(listener);
      document.removeEventListener('visibilitychange', visibilityChanged);
    });
  },
});
