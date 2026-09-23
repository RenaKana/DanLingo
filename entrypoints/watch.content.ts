import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { DEFAULT_SETTINGS, providerTimeoutMs } from '../src/core/config';
import { parseSources, watchIdFromUrl } from '../src/core/messages';
import { VideoScheduler } from '../src/core/scheduler';
import { SOURCE_CHUNK_BYTES, SOURCE_CHUNK_ITEMS } from '../src/core/source-stream';
import { BRIDGE } from '../src/platforms/niconico/native';
import { resourceFromUrl, matchesResourceUrl, sameSession, validSession } from '../src/core/resource';
import { adapterDiagnostic, adapterDiagnosticText, diagnosticCandidate, DIAGNOSTIC_LEASE_MS, parseAdapterDiagnostic } from '../src/core/adapter-diagnostic';
import { createProgress } from '../src/ui/progress';
import type { AdapterDiagnostic, PlaybackClock, Settings, RuntimeStatus, TranslationOutput, ResourceSession } from '../src/core/types';

export default defineContentScript({
  matches: ['https://www.nicovideo.jp/*', 'https://www.bilibili.com/*'], runAt: 'document_start',
  main(ctx) {
    let settings: Settings = { ...DEFAULT_SETTINGS };
    let performancePaused = false;
    const bilibili = location.origin === 'https://www.bilibili.com', documentSession = crypto.randomUUID();
    let hasKey = false; let bridgeScope: { resourceId: string; urlResourceId?: string; session: string; epoch: number } = { resourceId: '', session: '', epoch: 0 };
    let generation = 0; let sourceGeneration = 0; let lastPublished = 0; let lastBridge = 0;
    let staged = { translated: 0, original: 0 }; let notice = ''; let engineNotice = ''; let ready = false;
    let disposed = false; let settingsRead = 0; let revision = 0; let chunkIndex = -1;
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
    function loseNative() {
      if (ready) {
        const captured = bilibili ? resourceSession() : null;
        ready = false;
        if (captured && validSession(captured)) void browser.runtime.sendMessage({ type: 'session-close', session: captured }).catch(() => {});
        scheduler.dispose();
      }
    }
    function resourceSession(): ResourceSession {
      return { platform: 'bilibili', scenario: 'video', resourceId: bridgeScope.resourceId, urlResourceId: bridgeScope.urlResourceId, sessionId: documentSession, generation };
    }
    function onCurrentPage() { return bilibili ? matchesResourceUrl(resourceSession(), location.href) : bridgeScope.resourceId === watchIdFromUrl(location.href); }
    const send = (payload: Record<string, unknown>) => window.postMessage({ bridge: BRIDGE, from: 'content', ...bridgeScope, generation, ...payload }, location.origin);
    const control = (extra: Record<string, unknown> = {}) => send({ type: 'control', enabled: !performancePaused && settings.enabled && hasKey, displayMode: settings.displayMode, ...extra });
    const progress = createProgress(async (translationScope, prefetchSeconds) => {
      const response = await browser.runtime.sendMessage({ type: 'scheduling-settings', resourceId: bridgeScope.resourceId, ...(bilibili ? { session: resourceSession() } : {}), translationScope, prefetchSeconds });
      if (!response?.ok) throw new Error(response?.error || '设置未保存');
      applySettings(response);
    }, () => { notice = ''; scheduler.retryFailures(); publish(true); });
    const scheduler = new VideoScheduler({
      settings: { ...settings, enabled: settings.enabled && hasKey },
      async request(resourceId, items, signal, priority) {
        const requestScope = { ...bridgeScope, generation };
        const requestId = crypto.randomUUID();
        const cancel = () => { void browser.runtime.sendMessage({ type: 'cancel', requestId }).catch(() => {}); };
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) { cancel(); throw new Error('cancelled'); }
        try {
          const captured = bilibili ? resourceSession() : undefined;
          if (captured) {
            const opened = await browser.runtime.sendMessage({ type: 'session-open', session: captured });
            if (!opened?.ok || signal.aborted || !isCurrent(requestScope)) throw new Error('cancelled');
          }
          const response = await browser.runtime.sendMessage({ type: 'translate', requestId, resourceId, items, priority, ...(captured ? { session: captured } : {}) });
          if (signal.aborted || !isCurrent(requestScope)) throw new Error('cancelled');
          if (!response?.ok) {
            notice = response?.error || '扩展后台暂未就绪';
            if (response?.retryAfterMs) return items.map(item => ({ id: item.id, status: 'deferred' as const, retryAfterMs: response.retryAfterMs }));
            return items.map(item => ({ id: item.id, status: 'failed' as const, reason: 'background-rejected' }));
          }
          const results = response.items as TranslationOutput[];
          if (!Array.isArray(results)) throw new Error('invalid response');
          const failure = results.find(item => item.status === 'failed');
          notice = failure?.reason === 'http-401' || failure?.reason === 'http-403' ? '服务拒绝凭据，请检查 API Key 并保存' :
            failure?.reason === 'timeout' ? `翻译请求超过 ${Math.ceil(providerTimeoutMs(settings) / 1000)} 秒，当前显示原文；可调整超时或批次后重试` :
            results.some(item => item.reason === 'http-429') ? '服务限流，等待后继续准备' :
            results.some(item => item.status === 'deferred') ? '请求额度等待中，稍后继续准备' :
            failure?.reason === 'http-400' || failure?.reason === 'http-422' ? '服务拒绝请求参数，请检查模型和思考强度' : failure ? '部分翻译失败，当前显示原文' : '';
          return results;
        } finally { signal.removeEventListener('abort', cancel); }
      },
      prepared(items) { send({ type: 'prepared', items }); },
      removed(ids) { for (let i = 0; i < ids.length; i += 500) send({ type: 'forget', ids: ids.slice(i, i + 500) }); },
      reset() { generation++; control({ clear: true }); },
      status() { publish(); },
    });
    function isCurrent(scope: { resourceId: string; session: string; generation: number }): boolean {
      return !disposed && onCurrentPage() &&
        scope.resourceId === bridgeScope.resourceId && scope.session === bridgeScope.session && scope.generation === generation;
    }
    function publish(force = false) {
      if (disposed || (!force && performance.now() - lastPublished < 500)) return;
      lastPublished = performance.now();
      const stats = scheduler.getStats();
      const waiting = performancePaused ? '性能测试中，翻译暂时暂停' : stats.inflight > 0 && settings.thinkingEffort !== 'off'
        ? `等待模型思考与翻译结果 · 单次最多 ${Math.ceil(providerTimeoutMs(settings) / 1000)} 秒` : '';
      const coverageNote = bilibili && !collectionComplete ? stats.sourceComplete && !stats.messages
        ? '后续分段加载后会继续检查弹幕' : '已加载分段预译中；尚未确认当前视频的全部分段' : '';
      progress.attach(bridgeScope.session, bridgeScope.resourceId, bilibili ? 'bilibili' : 'niconico'); progress.update(settings, stats, engineNotice || notice || waiting || coverageNote, ready && hasKey, collectionComplete);
      const status: RuntimeStatus = {
        state: resourceFromUrl(location.href)?.scenario !== 'video' ? 'unsupported' : !settings.enabled ? 'disabled' : !hasKey ? 'configuration-needed' : !ready ? 'finding-player' : notice || engineNotice ? 'degraded' : stats.queued ? 'translating' : 'ready',
        platform: bilibili ? 'bilibili' : 'niconico', scenario: 'video',
        resourceId: bridgeScope.resourceId, messages: stats.messages, translated: staged.translated, original: staged.original,
        cacheHits: stats.cacheHits, queued: stats.queued, prepared: stats.translated, failed: stats.failed,
        nearTotal: stats.nearTotal, nearPrepared: stats.nearPrepared, inflight: stats.inflight, sourceComplete: stats.sourceComplete && collectionComplete,
        note: engineNotice || notice || waiting || (ready ? coverageNote || '普通文字 · 全池预译' : `等待受支持的 ${bilibili ? 'Bilibili' : 'Niconico'} 播放器`),
      };
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
        if (isCurrent(statusScope)) engineNotice = typeof response?.engineNotice === 'string' ? response.engineNotice.slice(0, 180) : '';
      }).catch(() => {});
    }
    function applySettings(response: any) {
      if (!response?.ok || !response.settings) return;
      settings = response.settings; hasKey = response.hasKey === true; performancePaused = response.performancePaused === true; notice = ''; engineNotice = '';
      scheduler.configure({ ...settings, enabled: !performancePaused && settings.enabled && hasKey });
      if (response.resetTranslations) {
        scheduler.dispose(); revision = 0; chunkIndex = -1; collectionComplete = !bilibili; sourceGeneration = generation; control({ resync: true });
      }
      control(); publish(true);
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
          loseNative();
        } else { notice = String(d.reason || '').slice(0, 120); ready = false; scheduler.dispose(); }
        publish(); return;
      }
      if (bilibili ? !matchesResourceUrl({ platform: 'bilibili', scenario: 'video', resourceId: d.resourceId, urlResourceId: d.urlResourceId }, location.href) : d.resourceId !== watchIdFromUrl(location.href)) return;
      if (typeof d.session !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(d.session) || !Number.isSafeInteger(d.epoch)) return;
      if (d.type === 'sources') {
        if (d.session !== bridgeScope.session || d.resourceId !== bridgeScope.resourceId || d.sourceGeneration !== sourceGeneration || !Number.isSafeInteger(d.revision) || !Number.isSafeInteger(d.index) || d.index < 0 ||
            !Array.isArray(d.upserts) || !Array.isArray(d.removes) || d.upserts.length + d.removes.length > SOURCE_CHUNK_ITEMS ||
            d.removes.some((id: unknown) => typeof id !== 'string' || id.length > 400) || new TextEncoder().encode(JSON.stringify(d)).length > SOURCE_CHUNK_BYTES) return;
        if (d.revision < revision || (d.revision === revision && d.index <= chunkIndex)) { send({ type: 'sources-ack', sourceGeneration, revision: d.revision, index: d.index }); return; }
        if ((d.revision !== revision && d.index !== 0) || (d.revision === revision && d.index !== chunkIndex + 1)) return;
        revision = d.revision; chunkIndex = d.index;
        collectionComplete = !bilibili || d.collectionComplete === true;
        // A finished source snapshot may cover only the segments loaded so far.
        scheduler.updateSources(parseSources(d.upserts, d.resourceId, bilibili ? 'bilibili' : 'niconico'), d.removes, d.reset === true, d.complete === true);
        send({ type: 'sources-ack', sourceGeneration, revision, index: chunkIndex }); publish(); return;
      }
      if (d.type !== 'snapshot') return;
      const c = d.clock;
      if (!c || !['mediaTimeMs', 'durationMs', 'playbackRate'].every(key => typeof c[key] === 'number' && Number.isFinite(c[key])) ||
          c.mediaTimeMs < 0 || c.durationMs <= 0 || c.playbackRate < 0.1 || c.playbackRate > 4 || c.durationMs > 86400000) return;
      const changed = bridgeScope.session !== d.session || bridgeScope.resourceId !== d.resourceId;
      const seeked = bridgeScope.epoch !== d.epoch;
      bridgeScope = { resourceId: d.resourceId, ...(bilibili ? { urlResourceId: d.urlResourceId } : {}), session: d.session, epoch: d.epoch };
      if (changed) { scheduler.dispose(); revision = 0; chunkIndex = -1; collectionComplete = !bilibili; sourceGeneration = 0; notice = ''; engineNotice = ''; }
      if (changed || seeked) staged = { translated: 0, original: 0 };
      if (configuredFor !== d.resourceId) { configuredFor = d.resourceId; readSettings(); }
      lastBridge = performance.now(); ready = true; nativeDiagnostic = null;
      const buffered = Array.isArray(c.buffered) ? c.buffered.slice(0, 100).filter((r: any) => Number.isFinite(r?.startMs) && Number.isFinite(r.endMs) && r.startMs >= 0 && r.endMs >= r.startMs && r.endMs <= c.durationMs + 1000) : [];
      const clock: PlaybackClock = { mediaTimeMs: c.mediaTimeMs, durationMs: c.durationMs, playbackRate: c.playbackRate,
        paused: c.paused === true, seeking: c.seeking === true, contentActive: c.contentActive === true, buffered };
      if (d.counts) for (const key of ['translated', 'original'] as const) if (Number.isSafeInteger(d.counts[key]) && d.counts[key] >= 0) staged[key] = d.counts[key];
      control(); scheduler.snapshot(d.resourceId, d.session, clock); publish();
    }
    window.addEventListener('message', receive);
    const listener = (message: any, sender: { id?: string; tab?: unknown }) => {
      if (sender.id !== browser.runtime.id || sender.tab !== undefined) return;
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
      if (performance.now() - lastBridge > 6000) { if (bilibili) loseNative(); else ready = false; }
      else { control(); scheduler.tick(); }
      publish();
    }, 500);
    ctx.onInvalidated(() => {
      disposed = true; settings.enabled = false; control(); scheduler.dispose(); clearInterval(timer); progress.dispose();
      window.removeEventListener('message', receive); browser.runtime.onMessage.removeListener(listener);
    });
  },
});
