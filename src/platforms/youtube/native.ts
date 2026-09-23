import { clockStamp, resourceFromUrl } from '../../core/resource.ts';
import { needsTranslation } from '../../core/messages.ts';
import { validLiveBufferMs } from '../../core/live-budget.ts';
import { protectText } from '../../translation/text.ts';
import type { ChatCoverage, LiveMetrics, LivePlaybackState } from '../../core/types.ts';
import { getTimeoutRetryPolicy } from '../../core/timeout-retry.ts';
import { chatSelection, findChatObject } from './chat.ts';
import { YoutubeNativeQueue, type NativeChatDecision, type NativeChatSource } from './native-queue.ts';
import { YoutubeChatRepairs } from './repairs.ts';

export const YOUTUBE_LIVE_BRIDGE = 'danlingo-live-v1';
type Data = Record<string, any>;
interface PageSession { resourceId: string; renderer: Data; liveNow: boolean; player: Data; video: HTMLVideoElement | null }
interface Surface { frame: HTMLIFrameElement; doc: Document; element: Element; owner: Data }
interface SourceState { authorId?: string; receivedAt: number; deadline: number; eligible: boolean; readyAt?: number }
interface Awaiting { decision: NativeChatDecision; expires: number; authorId?: string }
interface Cohort { id: string; session: string; at: number; deadline: number; eligible: boolean; withdrawn: boolean; presented: boolean; translated: boolean }
interface Binding extends Surface {
  resourceId: string; session: string; queue: YoutubeNativeQueue; detached: boolean; bypass: boolean;
  add: Function; action: Function; batch: Function; addWrapper: Function; actionWrapper: Function;
  addDescriptor?: PropertyDescriptor; actionDescriptor?: PropertyDescriptor;
  pending: Map<string, SourceState>; awaiting: Map<string, Awaiting>; observer: MutationObserver; repairs: YoutubeChatRepairs;
  repairScanErrorReported?: boolean;
}
const emptyPlayback = (): LivePlaybackState => ({ paused: true, seeking: false, contentActive: false, atLiveEdge: false });

function pageSession(): PageSession | null {
  try {
    const resource = resourceFromUrl(location.href);
    if (resource?.platform !== 'youtube' || resource.scenario !== 'live') return null;
    const host = window as unknown as Data;
    const player = document.querySelector('#movie_player') as unknown as Data | null;
    if (!player || typeof player.getVideoData !== 'function' || player.getVideoData()?.video_id !== resource.resourceId) return null;
    const flexy = document.querySelector('ytd-watch-flexy') as unknown as Data | null;
    const candidates = [typeof player.getPlayerResponse === 'function' ? player.getPlayerResponse() : null, flexy?.playerData, host.ytInitialPlayerResponse];
    const response = candidates.find(value => value?.videoDetails?.videoId === resource.resourceId);
    if (!response) return null;
    const liveNow = response.videoDetails.isLive === true || response.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow === true;
    let renderer: Data | null = null;
    const initial = host.ytInitialPlayerResponse?.videoDetails?.videoId === resource.resourceId ? host.ytInitialData : null;
    for (const source of [flexy?.data, initial]) {
      if (source?.currentVideoEndpoint?.watchEndpoint?.videoId && source.currentVideoEndpoint.watchEndpoint.videoId !== resource.resourceId) continue;
      const candidate = findChatObject(source, 'liveChatRenderer');
      if (candidate && !candidate.isReplay) { renderer = candidate; break; }
    }
    if (liveNow && !renderer) return null;
    return { resourceId: resource.resourceId, renderer: renderer || {}, liveNow, player, video: player.querySelector('video') };
  } catch { return null; }
}

function playbackOf(session: PageSession | null): LivePlaybackState {
  try {
    const video = session?.video;
    if (!session || !video?.isConnected) return emptyPlayback();
    const ad = session.player.classList?.contains('ad-showing') || session.player.classList?.contains('ad-interrupting');
    const state = typeof session.player.getPlayerState === 'function' ? session.player.getPlayerState() : -1;
    const error = session.player.querySelector('.ytp-error') as HTMLElement | null;
    const errorVisible = !!error && error.getClientRects().length > 0 && getComputedStyle(error).visibility !== 'hidden';
    let atLiveEdge = false;
    const native = session.liveNow && typeof session.player.isAtLiveHead === 'function' ? session.player.isAtLiveHead() : undefined;
    if (typeof native === 'boolean') atLiveEdge = native;
    else if (session.liveNow && video.seekable.length) {
      const delta = video.seekable.end(video.seekable.length - 1) - video.currentTime;
      atLiveEdge = Number.isFinite(delta) && delta >= -1 && delta <= 8;
    }
    return { paused: video.paused, seeking: video.seeking, contentActive: session.liveNow && !ad && !errorVisible && !video.error &&
      [1, 2, 3].includes(state) && !video.ended && video.readyState >= 2, atLiveEdge };
  } catch { return emptyPlayback(); }
}

function frameMatches(frame: HTMLIFrameElement, page: PageSession): boolean {
  try {
    if (!frame.isConnected || !frame.closest('ytd-live-chat-frame')) return false;
    const url = new URL(frame.contentWindow!.location.href);
    if (url.origin !== location.origin || url.pathname !== '/live_chat') return false;
    const explicit = url.searchParams.get('v');
    if (explicit) return explicit === page.resourceId;
    const token = url.searchParams.get('continuation');
    return !!token && token.length <= 10000 && (page.renderer.continuations || []).slice(0, 10)
      .some((row: Data) => row?.reloadContinuationData?.continuation === token);
  } catch { return false; }
}

function surfaceOf(page: PageSession): Surface | null {
  for (const frame of document.querySelectorAll<HTMLIFrameElement>('ytd-live-chat-frame iframe')) {
    try {
      if (!frameMatches(frame, page)) continue;
      const doc = frame.contentDocument, element = doc?.querySelector('yt-live-chat-item-list-renderer');
      if (!doc || !element) continue;
      const e = element as unknown as Data;
      const owner = [e.polymerController, e.inst, e].find(value => value &&
        ['handleAddChatItemAction_', 'handleLiveChatAction_', 'handleLiveChatActions_'].every(name => typeof value[name] === 'function'));
      if (owner) return { frame, doc, element, owner };
    } catch { /* Inaccessible or replaced frame stays native. */ }
  }
  return null;
}

function visibleElement(element: Element): boolean {
  if (!element.isConnected || !element.getClientRects().length) return false;
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0 || node.hasAttribute('hidden')) return false;
  }
  return true;
}
function chatVisible(surface: Surface): boolean {
  try {
    const fullscreen = document.fullscreenElement;
    return !document.hidden && !surface.doc.hidden && (!fullscreen || fullscreen.contains(surface.frame)) &&
      visibleElement(surface.frame) && visibleElement(surface.element);
  } catch { return false; }
}
function rowData(value: Data): Data | null { return value?.polymerController?.data || value?.inst?.data || value?.data || null; }
function seedIds(owner: Data): string[] {
  const values = [...(Array.isArray(owner.visibleItems) ? owner.visibleItems : []), ...(Array.isArray(owner.activeItems_) ? owner.activeItems_ : [])];
  return values.slice(-4000).map(value => value?.liveChatTextMessageRenderer?.id || rowData(value)?.id || value?.id).filter((id): id is string => typeof id === 'string').slice(-2000);
}
function percentiles(values: number[]): LiveMetrics['readinessMs'] {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]! : null;
  return { p50: at(.5), p95: at(.95), p99: at(.99), samples: sorted.length };
}
function language(value: unknown, auto: boolean): value is string {
  return typeof value === 'string' && value.length <= 40 && (auto && value === 'auto' || /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(value));
}

/** Intercept only proven native adds. No continuation requests or edits to existing rows. */
export function startYoutubeLiveBridge(): () => void {
  if (window.top !== window || location.origin !== 'https://www.youtube.com') return () => {};
  const host = window as unknown as Data;
  host.__danlingoYoutubeLiveStop?.();
  let disposed = false, enabled = false, navigating = false, frozen = false, lastControl = -Infinity;
  let bufferMs = 2000, superChatTimeoutMs = 15000, targetLanguage = 'zh-Hans', sourceLanguage = 'auto', configVersion = -1;
  let timeoutRetryEnabled = false, timeoutRetryExtraMs: unknown = 1000, timeoutRetryMode: unknown = 'hold';
  let resourceId = '', adapterSession = crypto.randomUUID(), binding: Binding | null = null;
  let failedOwner: Data | null = null, observedAt = performance.now();
  let readiness: number[] = [], releaseDelays: number[] = [], recent: Cohort[] = [];
  const counts = { received: 0, submitted: 0, presented: 0, translated: 0, original: 0, timedOut: 0, overloaded: 0, removed: 0, abandoned: 0, translatedChars: 0, cachedTranslated: 0 };
  const post = (payload: Data, b?: Binding) => window.postMessage({ bridge: YOUTUBE_LIVE_BRIDGE, from: 'adapter', platform: 'youtube',
    resourceId: b?.resourceId ?? resourceId, adapterSession: b?.session ?? adapterSession, ...payload }, location.origin);
  const sameOwner = (b: Binding): boolean => {
    if (disposed || navigating || frozen) return false;
    const page = pageSession();
    if (!page?.liveNow || page.resourceId !== b.resourceId || !frameMatches(b.frame, page)) return false;
    try {
      if (b.frame.contentDocument !== b.doc || !b.element.isConnected || b.doc.querySelector('yt-live-chat-item-list-renderer') !== b.element) return false;
      const e = b.element as unknown as Data;
      return (e.polymerController || e.inst || e) === b.owner;
    } catch { return false; }
  };
  const hooksIntact = (b: Binding) => b.owner.handleAddChatItemAction_ === b.addWrapper && b.owner.handleLiveChatAction_ === b.actionWrapper && b.owner.handleLiveChatActions_ === b.batch;
  const active = (b: Binding) => enabled && performance.now() - lastControl <= 6000 && !b.detached && !navigating && !frozen && chatVisible(b);
  const publish = () => {
    const page = pageSession(), valid = !!binding && sameOwner(binding), visible = valid && chatVisible(binding!);
    const available = valid && !binding!.detached && hooksIntact(binding!);
    const presentationActive = !!available && active(binding!);
    let coverage: ChatCoverage = chatSelection(page?.renderer).coverage;
    if (valid) {
      const element = binding!.doc.querySelector('yt-live-chat-renderer') as unknown as Data | null;
      const selected = chatSelection(element ? rowData(element) : null);
      if (selected.coverage !== 'unknown') coverage = selected.coverage;
    }
    const now = performance.now();
    recent = recent.filter(item => now - item.at <= 60000).slice(-20000);
    const cohort = recent.filter(item => item.eligible && !item.withdrawn && (item.presented || now >= item.deadline));
    const liveMetrics: LiveMetrics = { ...counts, pending: binding?.queue.size || 0, observationMs: Math.max(0, now - observedAt),
      readinessMs: percentiles(readiness), releaseDelayMs: percentiles(releaseDelays) };
    post({ type: 'snapshot', connection: page && !page.liveNow ? 'ended' : available ? 'connected' : enabled ? 'connecting' : 'disconnected',
      coverage, playback: playbackOf(page), presentationActive, liveMetrics, recentEligible: cohort.length,
      recentTranslated: cohort.filter(item => item.translated).length,
      reason: valid && !visible ? 'chat-hidden' : enabled && !available ? 'native-chat-entry-unavailable' : '', stamp: clockStamp() });
  };
  const inspectPresented = (b: Binding) => {
    if (!sameOwner(b)) { counts.abandoned += b.awaiting.size; b.awaiting.clear(); return; }
    const now = performance.now();
    for (const [id, entry] of b.awaiting) if (now >= entry.expires) { b.awaiting.delete(id); counts.abandoned++; }
    if (!b.awaiting.size || !chatVisible(b)) return;
    const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim();
    for (const row of [...b.element.querySelectorAll('yt-live-chat-text-message-renderer')].slice(-2000)) {
      const data = rowData(row as unknown as Data), id = data?.id;
      const waiting = b.awaiting.get(id);
      if (!waiting || !visibleElement(row)) continue;
      const expected = waiting.decision.action.item.liveChatTextMessageRenderer.message;
      const messageElement = row.querySelector('#message');
      const plain = typeof expected.simpleText === 'string' ? expected.simpleText : (expected.runs || []).map((run: Data) => typeof run.text === 'string' ? run.text : '').join('');
      if (!messageElement || JSON.stringify(data?.message) !== JSON.stringify(expected) || normalize(messageElement.textContent || '') !== normalize(plain)) continue;
      b.awaiting.delete(id); counts.presented++;
      if (waiting.decision.translated) {
        counts.translated++; counts.translatedChars += waiting.decision.textCharacters;
        if (waiting.decision.cached) counts.cachedTranslated++;
      } else counts.original++;
      const cohort = recent.find(item => item.id === id && item.session === b.session);
      if (cohort) { cohort.presented = true; cohort.translated = waiting.decision.translated; }
      post({ type: 'displayed', sourceId: id, id, translated: waiting.decision.translated, displayAt: performance.timeOrigin + now, stamp: clockStamp() }, b);
    }
  };
  const submit = (b: Binding, action: Data): boolean => {
    if (!sameOwner(b) || b.owner.handleLiveChatActions_ !== b.batch) return false;
    b.bypass = true;
    try { Reflect.apply(b.batch, b.owner, [[{ addChatItemAction: action }]]); return true; }
    catch { failedOwner = b.owner; return false; }
    finally { b.bypass = false; }
  };
  const restore = (b: Binding) => {
    for (const [name, wrapper, descriptor] of [
      ['handleAddChatItemAction_', b.addWrapper, b.addDescriptor], ['handleLiveChatAction_', b.actionWrapper, b.actionDescriptor],
    ] as const) {
      if (b.owner[name] !== wrapper) continue;
      try { if (descriptor) Object.defineProperty(b.owner, name, descriptor); else delete b.owner[name]; } catch { /* Never overwrite another hook. */ }
    }
  };
  const detach = (b: Binding, handoff: boolean) => {
    b.detached = true;
    b.repairs.dispose();
    if (handoff && sameOwner(b)) b.queue.flush('handoff'); else b.queue.abandon();
    restore(b);
    if (!sameOwner(b)) { counts.abandoned += b.awaiting.size; b.awaiting.clear(); b.observer.disconnect(); }
  };
  const forgetBinding = (handoff: boolean) => {
    if (!binding) return;
    detach(binding, handoff); inspectPresented(binding); binding.observer.disconnect();
    counts.abandoned += binding.awaiting.size; binding.awaiting.clear(); binding = null;
  };
  const attach = (surface: Surface): Binding | null => {
    const owner = surface.owner;
    const addDescriptor = Object.getOwnPropertyDescriptor(owner, 'handleAddChatItemAction_');
    const actionDescriptor = Object.getOwnPropertyDescriptor(owner, 'handleLiveChatAction_');
    if ([addDescriptor, actionDescriptor].some(d => d && (!('value' in d) || d.writable === false))) return null;
    const b = { ...surface, resourceId, session: adapterSession, detached: false, bypass: false,
      add: owner.handleAddChatItemAction_, action: owner.handleLiveChatAction_, batch: owner.handleLiveChatActions_, addDescriptor, actionDescriptor,
      pending: new Map(), awaiting: new Map() } as Binding;
    b.repairs = new YoutubeChatRepairs({ doc: b.doc, resourceId: b.resourceId, active: () => active(b) && sameOwner(b), now: () => performance.timeOrigin + performance.now(),
      eligible: text => needsTranslation(text, targetLanguage, sourceLanguage) && !protectText(text).reason,
      timeoutMs: () => superChatTimeoutMs, send: payload => post(payload, b) });
    const removed = (ids: string[], reason: 'removed' | 'abandoned') => {
      counts[reason] += ids.length;
      for (const id of ids) {
        b.pending.delete(id); b.awaiting.delete(id);
        if (reason === 'removed') {
          const cohort = recent.find(item => item.id === id && item.session === b.session);
          if (cohort) cohort.withdrawn = true;
        }
      }
      post({ type: 'events', events: [], removes: ids, removeAuthors: [], stamp: clockStamp() }, b);
    };
    b.queue = new YoutubeNativeQueue({ now: () => performance.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
      current: () => sameOwner(b), active: () => active(b), submit: action => submit(b, action),
      eligible: text => needsTranslation(text, targetLanguage, sourceLanguage) && !protectText(text).reason,
      retryPolicy: () => getTimeoutRetryPolicy({ liveBufferMs: bufferMs, youtubeTimeoutRetryEnabled: timeoutRetryEnabled,
        youtubeTimeoutRetryExtraMs: timeoutRetryExtraMs, youtubeTimeoutRetryMode: timeoutRetryMode }, 'youtube'),
      retry: (source, deadline) => b.repairs.requestTimeout(source.sourceId, source.originalText, performance.timeOrigin + deadline),
      cancelRetry: id => b.repairs.cancelTimeout(id),
      source: (source: NativeChatSource) => {
        counts.received++;
        b.pending.set(source.sourceId, { authorId: source.authorId, receivedAt: source.receivedAt, deadline: source.receivedAt + bufferMs, eligible: source.translatable });
        recent.push({ id: source.sourceId, session: b.session, at: source.receivedAt, deadline: source.receivedAt + bufferMs, eligible: source.translatable, withdrawn: false, presented: false, translated: false });
        if (recent.length > 20000) recent.shift();
        post({ type: 'events', events: [{ ...source, receivedAt: performance.timeOrigin + source.receivedAt }], removes: [], removeAuthors: [], stamp: clockStamp() }, b);
      },
      decision: decision => {
        decision.translated = b.repairs.decision(decision.sourceId, decision.action.item.liveChatTextMessageRenderer.message, decision.translated, decision.reason);
        const source = b.pending.get(decision.sourceId); b.pending.delete(decision.sourceId);
        counts.submitted++;
        if (decision.reason === 'timeout') counts.timedOut++;
        if (decision.reason === 'overload') counts.overloaded++;
        releaseDelays.push(Math.max(0, decision.releasedAt - decision.receivedAt)); if (releaseDelays.length > 1200) releaseDelays.shift();
        if (decision.translated && source?.readyAt !== undefined) { readiness.push(Math.max(0, source.readyAt - source.receivedAt)); if (readiness.length > 1200) readiness.shift(); }
        if (b.awaiting.size >= 2000) { b.awaiting.delete(b.awaiting.keys().next().value!); counts.abandoned++; }
        b.awaiting.set(decision.sourceId, { decision, expires: performance.now() + 10000, authorId: source?.authorId });
        post({ type: 'submitted', id: decision.sourceId, sourceId: decision.sourceId, translated: decision.translated, reason: decision.reason, stamp: clockStamp() }, b);
        inspectPresented(b);
      }, removed });
    b.queue.seed(seedIds(owner));
    b.addWrapper = function(this: Data, action: Data) {
      if (this !== owner || b.bypass || b.detached) return Reflect.apply(b.add, this, arguments);
      if (!sameOwner(b)) { detach(b, false); return Reflect.apply(b.add, this, arguments); }
      if (!hooksIntact(b)) { failedOwner = owner; detach(b, true); return Reflect.apply(b.add, this, arguments); }
      if (!active(b)) { detach(b, true); return Reflect.apply(b.add, this, arguments); }
      if (action?.item?.liveChatTextMessageRenderer) b.repairs.capture(action.item.liveChatTextMessageRenderer, false, 'queued');
      if (b.queue.add(action, bufferMs)) return;
      return Reflect.apply(b.add, this, arguments);
    };
    b.actionWrapper = function(this: Data, action: Data) {
      if (this !== owner || b.bypass || b.detached) return Reflect.apply(b.action, this, arguments);
      if (!sameOwner(b)) { detach(b, false); return Reflect.apply(b.action, this, arguments); }
      const replacement = action?.replaceChatItemAction;
      const replacedPending = typeof replacement?.targetItemId === 'string' && b.pending.has(replacement.targetItemId);
      const ids = [action?.removeChatItemAction?.targetItemId, action?.markChatItemAsDeletedAction?.targetItemId, replacement?.targetItemId].filter((id): id is string => typeof id === 'string' && id.length <= 300);
      const author = action?.markChatItemsByAuthorAsDeletedAction?.externalChannelId;
      if (typeof author === 'string' && author.length <= 200) {
        b.repairs.removeAuthor(author);
        for (const [id, source] of b.pending) if (source.authorId === author) ids.push(id);
        for (const [id, waiting] of b.awaiting) if (waiting.authorId === author) ids.push(id);
      }
      if (action?.clearChatAction || action?.clearLiveChatAction || action?.removeAllChatItemsAction) ids.push(...b.pending.keys(), ...b.awaiting.keys());
      const unique = [...new Set(ids)];
      b.repairs.remove(unique);
      if (action?.clearChatAction || action?.clearLiveChatAction || action?.removeAllChatItemsAction) b.repairs.clear();
      for (const id of unique) if (b.awaiting.delete(id)) {
        counts.removed++;
        const cohort = recent.find(item => item.id === id && item.session === b.session);
        if (cohort) cohort.withdrawn = true;
      }
      b.queue.remove(unique, false);
      try {
        const result = Reflect.apply(b.action, this, arguments);
        if (replacement?.replacementItem) b.repairs.replace(replacement.replacementItem);
        // Native replace cannot find an add that was held locally. Materialize
        // its replacement before later ready entries, never the canceled action.
        if (replacedPending && replacement.replacementItem && typeof replacement.replacementItem === 'object') submit(b, { item: replacement.replacementItem });
        return result;
      } finally { b.queue.pump(); }
    };
    b.observer = new MutationObserver(() => inspectPresented(b));
    try {
      Object.defineProperty(owner, 'handleAddChatItemAction_', addDescriptor ? { ...addDescriptor, value: b.addWrapper } : { value: b.addWrapper, configurable: true, writable: true });
      Object.defineProperty(owner, 'handleLiveChatAction_', actionDescriptor ? { ...actionDescriptor, value: b.actionWrapper } : { value: b.actionWrapper, configurable: true, writable: true });
      if (!hooksIntact(b)) throw new Error('native-hook-unavailable');
      b.observer.observe(b.element, { childList: true, subtree: true, characterData: true });
      return b;
    } catch { restore(b); b.observer.disconnect(); b.repairs.dispose(); return null; }
  };
  const tick = () => {
    if (disposed) return;
    if (enabled && performance.now() - lastControl > 6000) enabled = false;
    const page = pageSession(), candidate = resourceFromUrl(location.href);
    const nextId = candidate?.platform === 'youtube' && candidate.scenario === 'live' ? candidate.resourceId : '';
    if (nextId !== resourceId) {
      forgetBinding(false); resourceId = nextId; adapterSession = crypto.randomUUID(); failedOwner = null;
      for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0;
      readiness = []; releaseDelays = []; recent = []; observedAt = performance.now();
    }
    if (binding && !sameOwner(binding)) forgetBinding(false);
    if (binding) {
      if (!binding.detached && !hooksIntact(binding)) { failedOwner = binding.owner; detach(binding, true); }
      if (!enabled || !chatVisible(binding) || frozen || navigating) { if (!binding.detached) detach(binding, true); }
      inspectPresented(binding);
      if (!binding.detached) {
        try { binding.repairs.scan(); }
        catch {
          // Optional repair controls must not interrupt live intake or connection snapshots.
          if (!binding.repairScanErrorReported) {
            binding.repairScanErrorReported = true;
            console.warn('[DanLingo] YouTube repair controls could not be updated; live collection remains active.');
          }
        }
      }
    }
    if (enabled && !frozen && !navigating && page?.liveNow) {
      const surface = surfaceOf(page);
      if (surface && surface.owner !== failedOwner && chatVisible(surface) && (!binding || binding.detached)) {
        forgetBinding(true); adapterSession = crypto.randomUUID(); binding = attach(surface);
        if (!binding) failedOwner = surface.owner;
      }
    }
    publish();
  };
  const control = (event: MessageEvent) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (data?.bridge !== YOUTUBE_LIVE_BRIDGE || data.from !== 'content') return;
    if (data.type === 'control') {
      if (typeof data.enabled !== 'boolean' || !validLiveBufferMs(data.bufferMs) || !language(data.targetLanguage, false) ||
        !language(data.sourceLanguage, true) || !Number.isSafeInteger(data.configVersion) || data.configVersion < 0) return;
      const changed = configVersion !== data.configVersion || targetLanguage !== data.targetLanguage || sourceLanguage !== data.sourceLanguage;
      if (changed && binding) detach(binding, true);
      lastControl = performance.now(); enabled = data.enabled; bufferMs = data.bufferMs; targetLanguage = data.targetLanguage; sourceLanguage = data.sourceLanguage; configVersion = data.configVersion;
      superChatTimeoutMs = Number.isFinite(data.superChatTimeoutMs) ? Math.max(1000, Math.min(120000, data.superChatTimeoutMs)) : 15000;
      timeoutRetryEnabled = data.youtubeTimeoutRetryEnabled === true; timeoutRetryExtraMs = data.youtubeTimeoutRetryExtraMs; timeoutRetryMode = data.youtubeTimeoutRetryMode;
      tick(); return;
    }
    const b = binding;
    if (b && data.type === 'repair-result' && active(b) && sameOwner(b) && data.platform === 'youtube' && data.resourceId === b.resourceId && data.adapterSession === b.session) {
      const original = typeof data.sourceId === 'string' && typeof data.requestId === 'string' ? b.repairs.timeoutRequest(data.sourceId, data.requestId) : undefined;
      b.repairs.result(data);
      if (original !== undefined) b.queue.retryResult(data.sourceId, original,
        ['translated', 'cached'].includes(data.status) && typeof data.text === 'string' ? data.text : undefined, data.status === 'cached');
      return;
    }
    if (!b || !active(b) || !sameOwner(b) || data.platform !== 'youtube' || data.resourceId !== b.resourceId || data.adapterSession !== b.session ||
      typeof data.sourceId !== 'string' || data.sourceId.length > 300 || typeof data.originalText !== 'string' || data.originalText.length > 10000) return;
    if (data.type === 'release-original') b.queue.original(data.sourceId, data.originalText);
    else if (data.type === 'prepared' && typeof data.text === 'string' && data.text.length <= 2000 && typeof data.cached === 'boolean' &&
      Number.isFinite(data.preparedDelayMs) && data.preparedDelayMs >= 0 && data.preparedDelayMs <= 6000) {
      const source = b.pending.get(data.sourceId), previous = source?.readyAt;
      // prepare can synchronously submit the row, so decision sees this tentative
      // time. Rejected/duplicate results must not move a waiting row's readiness.
      if (source) source.readyAt = performance.now();
      const accepted = b.queue.prepare(data.sourceId, data.originalText, data.text, data.cached);
      if (source && !accepted) source.readyAt = previous;
    }
  };
  const navigateStart = () => { navigating = true; forgetBinding(false); adapterSession = crypto.randomUUID(); publish(); };
  const navigateFinish = () => { navigating = false; failedOwner = null; tick(); };
  const pageHide = () => { if (binding) detach(binding, true); frozen = true; publish(); };
  const pageShow = () => { frozen = false; tick(); };
  window.addEventListener('message', control); window.addEventListener('yt-navigate-start', navigateStart); window.addEventListener('yt-navigate-finish', navigateFinish);
  window.addEventListener('pagehide', pageHide); window.addEventListener('pageshow', pageShow);
  document.addEventListener('visibilitychange', tick); document.addEventListener('fullscreenchange', tick);
  const timer = setInterval(tick, 250);
  const stop = () => {
    if (disposed) return;
    enabled = false; forgetBinding(true); publish(); disposed = true; clearInterval(timer);
    window.removeEventListener('message', control); window.removeEventListener('yt-navigate-start', navigateStart); window.removeEventListener('yt-navigate-finish', navigateFinish);
    window.removeEventListener('pagehide', pageHide); window.removeEventListener('pageshow', pageShow);
    document.removeEventListener('visibilitychange', tick); document.removeEventListener('fullscreenchange', tick);
    if (host.__danlingoYoutubeLiveStop === stop) delete host.__danlingoYoutubeLiveStop;
  };
  host.__danlingoYoutubeLiveStop = stop; tick(); return stop;
}
