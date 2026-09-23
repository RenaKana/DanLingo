import { clockStamp, resourceFromUrl } from '../../core/resource.ts';
import { validLiveBufferMs } from '../../core/live-budget.ts';
import type { ChatCoverage, LiveConnection, LivePlaybackState } from '../../core/types.ts';
import { chatSelection, continuationFrom, findChatObject, YoutubeChatLedger, type ChatContinuation } from './chat.ts';

export const YOUTUBE_LIVE_BRIDGE = 'danlingo-live-v1';
type PageObject = Record<string, any>;
interface PageSession { resourceId: string; renderer: PageObject; context: PageObject; liveNow: boolean; player: PageObject; video: HTMLVideoElement | null }

function readPageSession(): PageSession | null {
  const resource = resourceFromUrl(location.href);
  if (resource?.platform !== 'youtube' || resource.scenario !== 'live') return null;
  const globals = window as unknown as PageObject;
  const player = document.querySelector('#movie_player') as unknown as PageObject | null;
  if (!player || typeof player.getVideoData !== 'function') return null;
  const videoData = player.getVideoData();
  if (videoData?.video_id !== resource.resourceId) return null;
  const flexy = document.querySelector('ytd-watch-flexy') as unknown as PageObject | null;
  const candidates = [typeof player.getPlayerResponse === 'function' ? player.getPlayerResponse() : null, flexy?.playerData, globals.ytInitialPlayerResponse];
  const response = candidates.find(value => value?.videoDetails?.videoId === resource.resourceId);
  if (!response) return null;
  const liveNow = response.videoDetails.isLive === true || response.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow === true;
  if (!liveNow) return { resourceId: resource.resourceId, renderer: {}, context: {}, liveNow: false, player, video: player.querySelector('video') };
  // Current player identity gates even the initial-data fallback; globals can remain from a previous SPA watch.
  let renderer: PageObject | null = null;
  const initialData = globals.ytInitialPlayerResponse?.videoDetails?.videoId === resource.resourceId ? globals.ytInitialData : null;
  for (const source of [flexy?.data, initialData]) {
    const candidate = findChatObject(source, 'liveChatRenderer');
    const sourceVideo = source?.currentVideoEndpoint?.watchEndpoint?.videoId;
    if (sourceVideo && sourceVideo !== resource.resourceId) continue;
    if (candidate && !candidate.isReplay) { renderer = candidate; break; }
  }
  const context = globals.ytcfg?.get?.('INNERTUBE_CONTEXT');
  if (!renderer || !context?.client) return null;
  return { resourceId: resource.resourceId, renderer, context, liveNow, player, video: player.querySelector('video') };
}
function pageSession(): PageSession | null {
  try { return readPageSession(); } catch { return null; }
}

function playbackOf(session: PageSession | null): LivePlaybackState {
  try { return readPlayback(session); } catch { return { paused: true, seeking: false, contentActive: false, atLiveEdge: false }; }
}
function readPlayback(session: PageSession | null): LivePlaybackState {
  const video = session?.video;
  if (!session || !video?.isConnected) return { paused: true, seeking: false, contentActive: false, atLiveEdge: false };
  const ad = session.player.classList?.contains('ad-showing') || session.player.classList?.contains('ad-interrupting');
  const state = typeof session.player.getPlayerState === 'function' ? session.player.getPlayerState() : -1;
  const errorPanel = session.player.querySelector('.ytp-error') as HTMLElement | null;
  const errorVisible = !!errorPanel && errorPanel.getClientRects().length > 0 && getComputedStyle(errorPanel).visibility !== 'hidden';
  let atLiveEdge = false;
  // Real watch pages may expose a seekable/duration end one hour into the future.
  // The current player isAtLiveHead() is authoritative when it returns a boolean.
  const nativeLiveHead = session.liveNow && typeof session.player.isAtLiveHead === 'function' ? session.player.isAtLiveHead() : undefined;
  if (typeof nativeLiveHead === 'boolean') atLiveEdge = nativeLiveHead;
  else if (session.liveNow && video.seekable.length) {
    const edge = video.seekable.end(video.seekable.length - 1);
    atLiveEdge = Number.isFinite(edge) && Number.isFinite(video.currentTime) && edge - video.currentTime >= -1 && edge - video.currentTime <= 8;
  }
  return { paused: video.paused, seeking: video.seeking, contentActive: session.liveNow && !ad && !errorVisible && !video.error && [1, 2, 3].includes(state) && !video.ended && video.readyState >= 2, atLiveEdge };
}

/** Same-origin structured state is optional for filter changes; requests never depend on frame visibility/lifetime. */
function nativeSelection(resourceId: string): ReturnType<typeof chatSelection> | null {
  for (const frame of document.querySelectorAll<HTMLIFrameElement>('ytd-live-chat-frame iframe')) {
    try {
      const url = new URL(frame.src, location.href);
      if (url.origin !== location.origin || url.pathname !== '/live_chat' || url.searchParams.get('v') !== resourceId) continue;
      const native = frame.contentWindow as unknown as PageObject | null;
      // SPA navigation may update src before the old frame document is replaced.
      const documentUrl = new URL(native?.location?.href || 'about:blank');
      if (documentUrl.origin !== location.origin || documentUrl.pathname !== '/live_chat' || documentUrl.searchParams.get('v') !== resourceId) continue;
      const renderer = native?.document?.querySelector('yt-live-chat-renderer') as PageObject | null;
      const candidates = [renderer?.data, native?.ytInitialData?.contents?.liveChatRenderer, native?.ytInitialData?.continuationContents?.liveChatContinuation];
      for (const candidate of candidates) { const choice = chatSelection(candidate); if (choice.coverage !== 'unknown') return choice; }
    } catch { /* No cross-origin access or all-frame permissions are required. */ }
  }
  return null;
}

async function readBoundedJson(response: Response): Promise<PageObject> {
  if (!response.body) throw new Error('Empty chat response');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > 3_000_000) { await reader.cancel(); throw new Error('Chat response size limit'); }
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object') throw new Error('Chat response unavailable');
    return value;
  } finally { reader.releaseLock(); }
}

/** Anonymous/current-page Innertube reader. No key, OAuth, background network or raw session bridge messages. */
export function startYoutubeLiveBridge(): () => void {
  if (window.top !== window || location.origin !== 'https://www.youtube.com') return () => {};
  const host = window as unknown as PageObject;
  host.__danlingoYoutubeLiveStop?.();
  let disposed = false, enabled = false, navigating = false, frozen = false;
  let lastControl = -Infinity;
  let resourceId = '', adapterSession = crypto.randomUUID(), connection: LiveConnection = 'disconnected', coverage: ChatCoverage = 'unknown';
  let controller: AbortController | null = null, cursor: ChatContinuation | null = null, reload: ChatContinuation | null = null;
  let baseline = true, dueAt = 0, failures = 0, wasActive = false, unsupportedFilter = false;
  const ledger = new YoutubeChatLedger();
  const emptyPlayback: LivePlaybackState = { paused: true, seeking: false, contentActive: false, atLiveEdge: false };
  let playback = emptyPlayback;
  const post = (payload: PageObject) => window.postMessage({ bridge: YOUTUBE_LIVE_BRIDGE, from: 'adapter', platform: 'youtube', resourceId, adapterSession, ...payload }, location.origin);
  const publish = () => post({ type: 'snapshot', connection, coverage, playback, stamp: clockStamp(),
    ...(unsupportedFilter ? { reason: 'unsupported-all-chat' } : {}) });
  const reset = (next: LiveConnection, keepReload = true) => {
    controller?.abort(); controller = null; adapterSession = crypto.randomUUID();
    cursor = null; baseline = true; ledger.clear(); connection = next;
    if (!keepReload) reload = null;
  };
  const active = () => enabled && !navigating && !frozen && !playback.paused && !playback.seeking && playback.contentActive && playback.atLiveEdge;
  const poll = async (session: PageSession) => {
    if (controller || !cursor || !active()) return;
    const currentId = resourceId, currentGeneration = adapterSession;
    const requestController = new AbortController(); controller = requestController;
    const timeout = setTimeout(() => requestController.abort(), 20000);
    let retryDelay = 0;
    try {
      const response = await fetch('/youtubei/v1/live_chat/get_live_chat?prettyPrint=false', {
        method: 'POST', credentials: 'same-origin', redirect: 'error', signal: requestController.signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ context: session.context, continuation: cursor.token, webClientInfo: { isDocumentHidden: document.hidden } }),
      });
      // Capture receipt before decoding/parsing; bridge work consumes the same finite display budget.
      const receivedAt = clockStamp();
      if (!response.ok) {
        const rawRetry = response.headers.get('retry-after');
        if (rawRetry) { const seconds = Number(rawRetry); retryDelay = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(rawRetry) - Date.now()); }
        throw new Error('Chat request failed');
      }
      const body = await readBoundedJson(response);
      const current = pageSession();
      if (disposed || requestController.signal.aborted || resourceId !== currentId || adapterSession !== currentGeneration || current?.resourceId !== currentId || !current.liveNow) return;
      playback = playbackOf(current);
      if (!active()) { reset('disconnected'); wasActive = false; publish(); return; }
      const renderer = body.continuationContents?.liveChatContinuation;
      if (!renderer || typeof renderer !== 'object') throw new Error('Chat continuation unavailable');
      const nextCursor = continuationFrom(renderer);
      if (!nextCursor) throw new Error('Chat continuation ended');
      const selected = chatSelection(renderer);
      if (selected.coverage === 'all') {
        // The menu's short reload token returned HTTP 400 in L0. All-chat intake remains unverified.
        unsupportedFilter = true; coverage = 'unknown'; reset('disconnected', false); wasActive = false; publish(); return;
      }
      if (selected.coverage !== 'unknown' && selected.coverage !== coverage) {
        // A server-selected scope is a new generation; suppress this response as its baseline.
        adapterSession = crypto.randomUUID(); ledger.clear(); baseline = true; coverage = selected.coverage;
      }
      const batch = ledger.read(renderer, receivedAt, baseline);
      cursor = nextCursor; baseline = false; failures = 0; connection = 'connected'; dueAt = performance.now() + nextCursor.timeoutMs;
      publish();
      if (batch.events.length || batch.removes.length || batch.removeAuthors.length) post({ type: 'events', ...batch });
    } catch {
      if (disposed || resourceId !== currentId || adapterSession !== currentGeneration || requestController.signal.aborted && controller !== requestController) return;
      failures++;
      reset('reconnecting');
      dueAt = performance.now() + Math.max(Number.isFinite(retryDelay) ? retryDelay : 0, Math.min(60000, 1000 * 2 ** Math.min(failures, 6)));
      publish();
    } finally {
      clearTimeout(timeout);
      if (controller === requestController) controller = null;
    }
  };
  const tick = () => {
    if (disposed) return;
    // The MAIN reader can outlive its isolated content script after an extension reload.
    // A bounded control lease releases its request even when the old context cannot send disable.
    if (enabled && performance.now() - lastControl > 6000) { enabled = false; wasActive = false; reset('disconnected'); }
    const session = pageSession();
    const candidate = resourceFromUrl(location.href);
    const nextId = candidate?.platform === 'youtube' && candidate.scenario === 'live' ? candidate.resourceId : '';
    if (resourceId !== nextId) {
      resourceId = nextId; coverage = 'unknown'; failures = 0; dueAt = 0; wasActive = false; unsupportedFilter = false; reset('connecting', false);
    }
    playback = playbackOf(session);
    if (!resourceId || !enabled || navigating || frozen) {
      if (connection !== 'disconnected') reset('disconnected');
      wasActive = false; publish(); return;
    }
    if (session && !session.liveNow) {
      if (connection !== 'ended') reset('ended', false);
      wasActive = false; publish(); return;
    }
    if (!session) { if (connection === 'connected') reset('connecting'); wasActive = false; publish(); return; }
    const nativeChoice = nativeSelection(resourceId);
    const selected = nativeChoice || chatSelection(session.renderer);
    if (selected.coverage === 'all' || unsupportedFilter && nativeChoice?.coverage !== 'top') {
      if (!unsupportedFilter || connection !== 'disconnected') reset('disconnected', false);
      unsupportedFilter = true; coverage = 'unknown'; wasActive = false; publish(); return;
    }
    if (unsupportedFilter && nativeChoice?.coverage === 'top') {
      unsupportedFilter = false; reset('connecting', false); dueAt = 0; wasActive = false;
    }
    if (coverage === 'unknown') coverage = selected.coverage;
    if (!reload) {
      // Only the actual current watch renderer's root continuation is L0-verified. Menu reload tokens are not usable bootstrap tokens.
      const rootContinuation = continuationFrom(session.renderer);
      if (rootContinuation?.kind === 'reloadContinuationData') reload = rootContinuation;
    }
    const nowActive = active();
    if (!nowActive) {
      if (wasActive || controller) reset('disconnected');
      wasActive = false; publish(); return;
    }
    if (!wasActive) { reset('connecting'); wasActive = true; dueAt = 0; }
    if (!cursor && performance.now() >= dueAt) {
      // Reload tokens establish a fresh current snapshot; never resume an old incremental cursor after a gap.
      cursor = reload;
      if (!cursor) { connection = 'disconnected'; publish(); return; }
      connection = failures ? 'reconnecting' : 'connecting';
    }
    publish();
    if (cursor && !controller && performance.now() >= dueAt) void poll(session);
  };
  const control = (event: MessageEvent) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (data?.bridge !== YOUTUBE_LIVE_BRIDGE || data.from !== 'content' || data.type !== 'control' || typeof data.enabled !== 'boolean') return;
    if (!validLiveBufferMs(data.bufferMs)) return;
    lastControl = performance.now();
    if (enabled !== data.enabled) { enabled = data.enabled; dueAt = 0; wasActive = false; reset(enabled ? 'connecting' : 'disconnected'); }
    tick();
  };
  const navigateStart = () => { navigating = true; wasActive = false; reset('connecting', false); publish(); };
  const navigateFinish = () => { navigating = false; dueAt = 0; tick(); };
  const pageHide = () => { frozen = true; wasActive = false; reset('disconnected'); publish(); };
  const pageShow = () => { frozen = false; dueAt = 0; tick(); };
  window.addEventListener('message', control);
  window.addEventListener('yt-navigate-start', navigateStart);
  window.addEventListener('yt-navigate-finish', navigateFinish);
  window.addEventListener('pagehide', pageHide);
  window.addEventListener('pageshow', pageShow);
  for (const event of ['pause', 'play', 'seeking', 'seeked', 'emptied', 'error']) document.addEventListener(event, tick, true);
  const timer = setInterval(tick, 1000);
  const stop = () => {
    if (disposed) return; disposed = true; enabled = false; reset('disconnected'); publish(); clearInterval(timer);
    window.removeEventListener('message', control); window.removeEventListener('yt-navigate-start', navigateStart); window.removeEventListener('yt-navigate-finish', navigateFinish);
    window.removeEventListener('pagehide', pageHide); window.removeEventListener('pageshow', pageShow);
    for (const event of ['pause', 'play', 'seeking', 'seeked', 'emptied', 'error']) document.removeEventListener(event, tick, true);
    if (host.__danlingoYoutubeLiveStop === stop) delete host.__danlingoYoutubeLiveStop;
  };
  host.__danlingoYoutubeLiveStop = stop; tick();
  return stop;
}
