import { sourceEventId, watchIdFromUrl, MAX_TEXT_LENGTH } from '../../core/messages.ts';
import type { PlaybackClock, SourceMessage } from '../../core/types.ts';
import { SourcePublisher } from '../../core/source-stream.ts';
import { videoPriority } from '../../core/scheduler.ts';

export const BRIDGE = 'danlingo.native.v1';
const FILTER = 'danlingo-text-v1';
// Website-owned objects are deliberately accessed through a small runtime fingerprint.
type Native = Record<string, any>;
const ORDINARY = new Set(['184', 'naka', 'ue', 'shita', 'small', 'medium', 'big', 'defont', 'mincho', 'gothic',
  'white', 'red', 'pink', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'black',
  'white2', 'red2', 'pink2', 'orange2', 'yellow2', 'green2', 'cyan2', 'blue2', 'purple2', 'black2']);
// Niconico parses device:Switch into device metadata, separate from rendering commands.
// Admit only a single device token; all other commands still need the ordinary whitelist.
const DEVICE_METADATA = /^device:[a-z0-9_-]+$/i;

export function isNativePlayer(value: unknown, resourceId: string): value is Native {
  const p = value as Native | null;
  return !!p && typeof p === 'object' && p.watch?.video?.id === resourceId && !p.isDisposed &&
    !p.context?.isPreview && !p.context?.isShort && typeof p.getCurrentTime === 'function' &&
    typeof p.getVideoElement === 'function' && p.getVideoElement() instanceof HTMLVideoElement &&
    p.getVideoElement().isConnected && p.commentRenderer?.parentElement?.isConnected &&
    Array.isArray(p.commentRenderer.layerProcessorList) &&
    p.commentRenderer.layerProcessorList.every((layer: Native) => typeof layer.addStagingFilter === 'function' && typeof layer.removeStagingFilter === 'function');
}

export function findNativePlayer(resourceId: string): Native | null {
  const seen = new Set<object>(); const fiberSeen = new Set<object>(); let budget = 5000;
  function inspect(value: any, depth = 0): Native | null {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 5 || --budget < 0) return null;
    seen.add(value);
    if (isNativePlayer(value, resourceId)) return value;
    if (value instanceof Node || value === window) return null;
    const children = Array.isArray(value) ? value.slice(0, 16) : ['memoizedState', 'baseState', 'deps', 'current', 'value', 'player'].map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && 'value' in descriptor ? descriptor.value : null;
    });
    for (const child of children) { const p = inspect(child, depth + 1); if (p) return p; }
    return null;
  }
  for (const element of document.querySelectorAll('canvas,video')) {
    let ancestor: Element | null = element;
    for (let d = 0; ancestor && d < 8; d++, ancestor = ancestor.parentElement) {
      const key = Object.keys(ancestor).find(k => k.startsWith('__reactFiber$'));
      let fiber = key ? (ancestor as any)[key] : null;
      for (let f = 0; fiber && f < 35; f++, fiber = fiber.return) {
        if (fiberSeen.has(fiber)) continue;
        fiberSeen.add(fiber);
        const fromProps = inspect(fiber.memoizedProps); if (fromProps) return fromProps;
        let hook = fiber.memoizedState; const hooks = new Set();
        for (let h = 0; hook && h < 70 && !hooks.has(hook); h++, hook = hook.next) {
          hooks.add(hook); const p = inspect(hook); if (p) return p;
        }
      }
    }
  }
  return null;
}

function ordinary(chat: Native): boolean {
  const raw = chat.comment;
  return !!raw && typeof raw.body === 'string' && raw.body.length > 0 && raw.body.length <= MAX_TEXT_LENGTH &&
    !/[\r\n]/u.test(raw.body) && chat.fork !== 'owner' && ['naka', 'ue', 'shita'].includes(chat.position) &&
    Array.isArray(raw.commands) && raw.commands.every((command: unknown) => typeof command === 'string' &&
      (ORDINARY.has(command.toLowerCase()) || /^#[0-9a-f]{6}$/i.test(command) || DEVICE_METADATA.test(command)));
}

/** Derived staging timing for ordinary, non-short comments only; source vpos stays unchanged. */
export function preparationTime(vposMs: number, position: string, durationMs: number): number {
  const fixed = position === 'ue' || position === 'shita';
  const normal = fixed ? vposMs : vposMs - 2000;
  return durationMs > 0 ? Math.min(normal, durationMs - (fixed ? 3000 : 5000)) : normal;
}

export function startNativeBridge(): () => void {
  let player: Native | null = null;
  let resourceId = '';
  let session = crypto.randomUUID(); let epoch = 0;
  let enabled = false; let mode = 'translated'; let lastLease = performance.now(); let receivedControl = false;
  let lastDiscovery = -Infinity; let lastSources = -Infinity;
  let lastTime = 0; let timeSample = 0;
  let generation = 0; let sourceGeneration = 0; let everPlayed = false; let refreshReserved = false;
  const layers = new Set<Native>();
  const prepared = new Map<string, { text: string; originalText: string }>();
  const decisions = new Map<string, { text: string | null; originalText: string }>();
  let sources = new Map<string, SourceMessage>();
  const disposes: (() => void)[] = [];
  let staged = 0; let translated = 0; let original = 0; let poolCount = 0;
  let stopped = false;
  let suspended = false;
  const post = (payload: Record<string, unknown>) => window.postMessage({ bridge: BRIDGE, from: 'native', session, epoch, resourceId, ...payload }, location.origin);
  const publisher = new SourcePublisher(chunk => post({ type: 'sources', sourceGeneration, ...chunk }));
  const messageId = (chat: Native) => sourceEventId(resourceId, String(chat.thread ?? ''), String(chat.fork ?? ''), String(chat.id ?? ''));

  function filter(chat: Native, settings: Native): Native {
    if (!enabled || mode !== 'translated' || !player || player._isInterrupting ||
        player.watch?.video?.id !== watchIdFromUrl(location.href) || !settings.visible ||
        settings.content !== chat.comment?.body || !ordinary(chat)) return settings;
    const id = messageId(chat);
    if (decisions.get(id)?.originalText !== chat.comment.body) {
      const item = prepared.get(id);
      const value = item && item.originalText === chat.comment.body ? item.text : null;
      decisions.set(id, { text: value, originalText: chat.comment.body }); staged++; if (value !== null) translated++; else original++;
    }
    const text = decisions.get(id)?.text;
    return typeof text === 'string' ? { ...settings, content: text } : settings;
  }

  function removeFilters(): void {
    for (const layer of layers) { try { layer.removeStagingFilter(FILTER); } catch { /* disposed native instance */ } }
    layers.clear();
  }

  function syncFilters(): void {
    if (player && enabled && mode === 'translated') {
      for (const layer of player.commentRenderer.layerProcessorList as Native[]) {
        if (!layers.has(layer)) { layer.addStagingFilter(FILTER, filter); layers.add(layer); }
      }
    } else if (layers.size) removeFilters();
  }

  function nextEpoch(): void {
    epoch++; decisions.clear();
    staged = translated = original = 0;
  }

  function detach(): void {
    removeFilters(); for (const dispose of disposes.splice(0)) dispose();
    const parent = player?.commentRenderer?.parentElement as HTMLElement | undefined;
    if (parent?.dataset.danlingoPlayer === session) delete parent.dataset.danlingoPlayer;
    player = null; enabled = false; prepared.clear(); decisions.clear(); sources.clear(); publisher.reset(); poolCount = 0;
    generation = 0; sourceGeneration = 0; lastSources = -Infinity; refreshReserved = false;
  }

  function getClock(): PlaybackClock {
    const video = player!.getVideoElement() as HTMLVideoElement;
    const active = !player!._isInterrupting && !player!.isDummyVideo?.() && player!.isReady?.() === true &&
      player!.watch?.video?.id === watchIdFromUrl(location.href);
    return {
      mediaTimeMs: Math.max(0, player!.getCurrentTime() * 1000),
      durationMs: player!.watch.video.duration * 1000,
      playbackRate: Math.max(0.1, Math.min(4, player!.getPlaybackRate())),
      paused: video.paused || !player!.isPlaying(), seeking: player!.isSeeking() || video.seeking,
      contentActive: active,
      buffered: Array.from({ length: Math.min(video.buffered.length, 100) }, (_, i) => ({ startMs: video.buffered.start(i) * 1000, endMs: video.buffered.end(i) * 1000 })),
    };
  }

  function getSources(clock: PlaybackClock): SourceMessage[] {
    const rows: SourceMessage[] = []; poolCount = 0;
    for (const layer of player!.commentRenderer.layerProcessorList as Native[]) {
      const chats = layer.stagingChatManager?.chatList;
      if (!Array.isArray(chats)) continue;
      poolCount += chats.length;
      for (const chat of chats) {
        const raw = chat.comment;
        if (!raw || typeof raw.body !== 'string' || raw.body.length > MAX_TEXT_LENGTH || !Number.isFinite(chat.vposMs) || chat.vposMs < 0 || chat.vposMs > clock.durationMs) continue;
        if (String(chat.id ?? '').length > 100 || String(chat.thread ?? '').length > 100) continue;
        const duration = Number(layer.processor?.contentLengthMs) > 0 ? Number(layer.processor.contentLengthMs) : clock.durationMs;
        const row: SourceMessage = {
          id: messageId(chat), sourceId: String(chat.id), platform: 'niconico', resourceId,
          threadId: String(chat.thread ?? ''), fork: String(chat.fork ?? ''), originalText: raw.body,
          mediaTimeMs: chat.vposMs, renderAtMs: preparationTime(chat.vposMs, chat.position, duration),
          translatable: ordinary(chat),
          style: { position: String(chat.position).slice(0, 20), size: String(chat.size).slice(0, 20), color: String(chat.color).slice(0, 30), font: String(chat.font).slice(0, 100),
            commands: Array.isArray(raw.commands) ? raw.commands.filter((x: unknown) => typeof x === 'string').slice(0, 30).map((x: string) => x.slice(0, 100)) : [] },
        };
        const posted = Date.parse(raw.postedAt); if (Number.isFinite(posted)) row.sentAtEpochMs = posted;
        rows.push(row);
      }
    }
    sources = new Map(rows.map(row => [row.id, row]));
    for (const [id, item] of prepared) if (sources.get(id)?.originalText !== item.originalText) prepared.delete(id);
    for (const id of decisions.keys()) if (!sources.has(id)) decisions.delete(id);
    const rank = { near: 0, buffered: 1, background: 2 };
    return [...sources.values()].sort((a, b) => rank[videoPriority(a, clock, 5)] - rank[videoPriority(b, clock, 5)] || a.renderAtMs - b.renderAtMs);
  }

  function tick(): void {
    if (stopped || suspended) return;
    const id = watchIdFromUrl(location.href);
    if (player && (id !== resourceId || !isNativePlayer(player, id ?? ''))) detach();
    if (!id) { post({ type: 'unavailable', reason: '仅支持 Niconico 普通视频' }); return; }
    if (!player && performance.now() - lastDiscovery > 1000) {
      lastDiscovery = performance.now(); player = findNativePlayer(id);
      if (player) {
        resourceId = id; session = crypto.randomUUID(); nextEpoch();
        const video = player.getVideoElement() as HTMLVideoElement;
        player.commentRenderer.parentElement.dataset.danlingoPlayer = session;
        everPlayed = video.played.length > 0 || !video.paused;
        const playing = () => { everPlayed = true; };
        video.addEventListener('playing', playing); disposes.push(() => video.removeEventListener('playing', playing));
        const seeking = () => { nextEpoch(); tick(); };
        video.addEventListener('seeking', seeking); disposes.push(() => video.removeEventListener('seeking', seeking));
        lastTime = player.getCurrentTime() * 1000; timeSample = performance.now();
      }
    }
    if (!player) { post({ type: 'unavailable', reason: '正在等待受支持的原生播放器' }); return; }
    if (performance.now() - lastLease > 6000 && receivedControl) { enabled = false; removeFilters(); }
    const clock = getClock();
    const expected = lastTime + (clock.paused ? 0 : (performance.now() - timeSample) * clock.playbackRate);
    if (!clock.seeking && Math.abs(clock.mediaTimeMs - expected) > 1500) nextEpoch();
    lastTime = clock.mediaTimeMs; timeSample = performance.now();
    syncFilters();
    post({ type: 'snapshot', clock, counts: { pool: poolCount, staged, translated, original }, sourceComplete: publisher.complete, native: 'staging-filter' });
    if (!publisher.busy && performance.now() - lastSources > 1000) {
      lastSources = performance.now();
      publisher.update(getSources(clock), performance.now());
    }
    publisher.pump(performance.now());
  }

  function onMessage(event: MessageEvent): void {
    const d = event.data;
    if (event.source !== window || event.origin !== location.origin || !d || d.bridge !== BRIDGE || d.from !== 'content' ||
        d.session !== session || d.resourceId !== resourceId) return;
    if (d.type === 'control') {
      if (!Number.isSafeInteger(d.generation) || d.generation < generation) return;
      lastLease = performance.now(); receivedControl = true;
      enabled = d.enabled === true; mode = d.displayMode === 'original' ? 'original' : 'translated';
      if (generation !== d.generation || d.clear === true) { generation = d.generation; prepared.clear(); if (!everPlayed) decisions.clear(); }
      if (d.resync === true) { sourceGeneration = d.generation; publisher.reset(); lastSources = -Infinity; }
      syncFilters();
    } else if (d.type === 'sources-ack') {
      if (d.sourceGeneration === sourceGeneration) publisher.acknowledge(d.revision, d.index, performance.now());
    } else if (d.type === 'forget' && d.generation === generation && Array.isArray(d.ids) && d.ids.length <= 500) {
      for (const id of d.ids) if (typeof id === 'string') prepared.delete(id);
    } else if (d.type === 'prepared' && d.generation === generation && enabled && Array.isArray(d.items) && d.items.length <= 200) {
      let changed = false;
      for (const item of d.items) {
        if (typeof item?.id === 'string' && item.id.length <= 400 && typeof item.text === 'string' && item.text.trim() && item.text.length <= 2000 &&
            typeof item.originalText === 'string' && sources.get(item.id)?.originalText === item.originalText) {
          prepared.set(item.id, { text: item.text, originalText: item.originalText }); changed = true;
          if (!everPlayed) decisions.delete(item.id);
        }
      }
      // Only an as-yet-unplayed paused video may be remeasured. Never repaint active comments.
      if (changed && !everPlayed && !refreshReserved && player?.getVideoElement().paused && typeof player.commentRenderer.refreshComments === 'function') {
        refreshReserved = true;
        queueMicrotask(() => {
          refreshReserved = false;
          if (player && !everPlayed && player.getVideoElement().paused && !player._isInterrupting) player.commentRenderer.refreshComments();
        });
      }
    }
  }
  window.addEventListener('message', onMessage);
  const timer = setInterval(() => { try { tick(); } catch { detach(); post({ type: 'unavailable', reason: '原生接口变化，已恢复原文' }); } }, 250);
  // A BFCache return resumes the document without rerunning content scripts.
  const hide = () => { suspended = true; detach(); };
  const show = () => { suspended = false; lastDiscovery = -Infinity; };
  const stop = () => {
    stopped = true; clearInterval(timer); window.removeEventListener('message', onMessage);
    window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show); detach();
  };
  window.addEventListener('pagehide', hide);
  window.addEventListener('pageshow', show);
  return stop;
}
