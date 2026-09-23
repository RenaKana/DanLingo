import { validLiveBufferMs } from '../../core/live-budget.ts';
import { needsTranslation } from '../../core/messages.ts';
import { getTimeoutRetryPolicy } from '../../core/timeout-retry.ts';
import { protectText } from '../../translation/text.ts';
import { NiconicoCommentSidebar } from './sidebar.ts';
/** Current Niconico LIVE watch-page adapter. Private native API is fingerprinted and fails to originals. */
export function startNiconicoLiveBridge(): () => void {
  type Native = Record<string, any>;
  const OWNER = '__danlingoNiconicoLiveStopV1', owner = window as unknown as Native;
  if (typeof owner[OWNER] === 'function') owner[OWNER]();
  type Identity = { resourceId: string; adapterSession: string };
  type Pending = Identity & { sourceId: string; key: string; source: Native; originalText: string; rest: unknown[];
    receivedAt: number; deadline: number; released: boolean; prepared?: string; timer: ReturnType<typeof setTimeout>;
    eligible: boolean; retryAttempted: boolean; retrying: boolean; retryRequestId?: string };
  type Decision = Identity & { sourceId: string; originalText: string; text?: string; releasedAt: number; expires: number; delivered: boolean; owner: Native };
  type ResetReason = 'inactive' | 'session-reset';
  const BRIDGE = 'danlingo-live-v1', FILTER = 'danlingo-live-text-v1';
  const MAX_PENDING = 300, MAX_DECISIONS = 1200, MAX_TEXT = 1000, LEASE_MS = 6000;
  const commands = new Set(['184', 'naka', 'ue', 'shita', 'small', 'medium', 'big', 'defont', 'mincho', 'gothic',
    'white', 'red', 'pink', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'black',
    'white2', 'red2', 'pink2', 'orange2', 'yellow2', 'green2', 'cyan2', 'blue2', 'purple2', 'black2']);
  const stamp = () => performance.timeOrigin + performance.now();
  const watchId = () => /^\/watch\/(lv\d+)\/?$/.exec(location.pathname)?.[1] ?? '';
  const keyOf = (chat: Native) => {
    const p = chat.parsedOriginalChat ?? chat;
    return JSON.stringify([p.no, p.date, p.date_usec ?? p.dateUsec ?? 0]);
  };
  let resourceId = watchId(), adapterSession = crypto.randomUUID();
  let enabled = false, bufferMs = 2000, targetLanguage = 'zh-Hans', sourceLanguage = 'auto', timeoutRetryEnabled = false, timeoutRetryExtraMs: unknown = 1000, timeoutRetryMode: unknown = 'hold', lastLease = -Infinity, stopped = false, suspended = false;
  let configVersion: number | undefined;
  let connection: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' = 'connecting';
  let attachment: Native | null = null, lastDiscovery = -Infinity, lastSnapshot = -Infinity, wasPlayable = false;
  let lastRepairScan = -Infinity;
  let cancelVisibleScan: (() => void) | undefined;
  let previousRoomComponent: Native | null = null;
  const pending = new Map<string, Pending>(), decisions = new Map<string, Decision>();
  const sidebar = new NiconicoCommentSidebar();
  const seen = new Map<string, { text: string; at: number }>();
  const wire = new Map<string, { id: string; text: string; sentAtEpochMs: number; at: number }>();
  const protocolTargets = new WeakSet<EventTarget>();
  const post = (payload: Native) => window.postMessage({ bridge: BRIDGE, from: 'adapter', platform: 'niconico', resourceId, adapterSession, ...payload }, location.origin);
  const retryPolicy = () => getTimeoutRetryPolicy({ liveBufferMs: bufferMs, niconicoTimeoutRetryEnabled: timeoutRetryEnabled,
    niconicoTimeoutRetryExtraMs: timeoutRetryExtraMs, niconicoTimeoutRetryMode: timeoutRetryMode }, 'niconico');
  function ordinary(chat: Native): boolean {
    return typeof chat?.content === 'string' && !!chat.content.trim() && chat.content.length <= MAX_TEXT &&
      !/[\r\n]/u.test(chat.content) && !chat.content.startsWith('/') && !(Number(chat.premium) & 6) && !chat.yourpost &&
      Number.isSafeInteger(chat.no) && chat.no >= 0 && Number.isFinite(chat.vpos) && Number.isFinite(chat.date) &&
      !chat.deleted && (typeof chat.mail === 'string' ? chat.mail.split(/\s+/).filter(Boolean) : []).every((c: string) =>
        commands.has(c.toLowerCase()) || /^#[\da-f]{6}$/i.test(c) || /^device:[a-z0-9_-]+$/i.test(c));
  }
  function nativeAlive(a = attachment): boolean {
    return !!a && watchId() === resourceId && a.element.isConnected && a.component.renderer === a.renderer &&
      a.component.threadProcessor === a.thread && Array.isArray(a.renderer.layerProcessorList) &&
      a.renderer.layerProcessorList.length === a.layers.length && a.renderer.layerProcessorList.every((layer: Native, i: number) => layer === a.layers[i]);
  }
  function findVideo(): HTMLVideoElement | null {
    // The official pc-watch setupVideoElement uses this exact selector. Billboard and
    // sticky-ad videos live outside this layer and must never establish playback state.
    const video = document.querySelector<HTMLVideoElement>("[data-layer-name='videoLayer'] video");
    if (!video) return null;
    const rect = video.getBoundingClientRect();
    return video.isConnected && rect.width > 0 && rect.height > 0 && video.videoWidth > 0 ? video : null;
  }
  function playback() {
    const video = attachment && nativeAlive() ? findVideo() : null;
    const atLiveEdge = !!document.querySelector('[data-live-status="live"]') && !document.querySelector('[data-live-status="chase"]');
    return { paused: !video || video.paused, seeking: !!video?.seeking,
      contentActive: !!video && !video.ended && video.readyState >= 2 && !!attachment && nativeAlive(), atLiveEdge };
  }
  function playable(): boolean {
    if (!enabled || suspended || document.hidden || !navigator.onLine || !nativeAlive() || connection === 'reconnecting' || connection === 'disconnected') return false;
    const p = playback(); return p.contentActive && !p.paused && !p.seeking && p.atLiveEdge;
  }
  function snapshot() {
    post({ type: 'snapshot', connection: navigator.onLine ? connection : 'disconnected', coverage: 'all', playback: playback(), stamp: stamp() });
    lastSnapshot = performance.now();
  }
  function trim() {
    const now = performance.now();
    for (const [key, item] of decisions) if (item.expires < now) decisions.delete(key);
    for (const [key, item] of seen) if (now - item.at > 60000) seen.delete(key);
    for (const [key, item] of wire) if (now - item.at > 30000) wire.delete(key);
    while (decisions.size > MAX_DECISIONS) decisions.delete(decisions.keys().next().value!);
    while (seen.size > 2400) seen.delete(seen.keys().next().value!);
    while (wire.size > 512) wire.delete(wire.keys().next().value!);
  }
  function discard(row: Pending, reason: ResetReason | 'age') {
    if (row.released) return;
    cancelRetry(row);
    row.released = true; clearTimeout(row.timer); pending.delete(row.sourceId);
    post({ type: 'dropped', sourceId: row.sourceId, resourceId: row.resourceId, adapterSession: row.adapterSession, reason });
  }
  function cancelRetry(row: Pending) {
    if (!row.retrying || !row.retryRequestId) return;
    post({ type: 'repair-cancel', sourceId: row.sourceId, requestId: row.retryRequestId });
    row.retrying = false; row.retryRequestId = undefined;
  }
  function retryOrRelease(row: Pending) {
    if (row.released) return;
    if (row.prepared || row.retryAttempted || !row.eligible) { release(row); return; }
    row.retryAttempted = true;
    const policy = retryPolicy();
    if (!policy) { release(row); return; }
    const retryDeadline = row.deadline + policy.timeoutMs, requestId = crypto.randomUUID();
    post({ type: 'repair-request', sourceId: row.sourceId, originalText: row.originalText, requestId,
      strategy: 'manual', manual: false, force: false, purpose: 'timeout', timeoutMs: policy.timeoutMs,
      retryDeadlineAt: performance.timeOrigin + retryDeadline });
    if (!policy.hold) { release(row); return; }
    row.retrying = true; row.retryRequestId = requestId; row.deadline = retryDeadline;
    clearTimeout(row.timer); row.timer = setTimeout(() => retryOrRelease(row), Math.max(1, retryDeadline - performance.now()));
  }
  function release(row: Pending, originalOnly = false) {
    if (row.released) return;
    const a = attachment;
    if (!a || !nativeAlive(a) || row.resourceId !== resourceId || row.adapterSession !== adapterSession) {
      discard(row, 'session-reset'); return;
    }
    // A deadline can fire before the next playback poll. Only explicit shutdown hands originals back.
    if (!originalOnly && !playable()) { discard(row, 'inactive'); return; }
    if (!originalOnly && performance.now() - row.deadline > 1000) {
      discard(row, 'age'); return;
    }
    cancelRetry(row);
    row.released = true; clearTimeout(row.timer); pending.delete(row.sourceId);
    // The site already assigns live vpos at receipt. Move only a clone to the release clock;
    // native conversion keeps its own +200cs moving-comment convention and NG/style filters.
    const clock = Number(a.component.props.getCurrentVposMs());
    const copy = { ...row.source, vpos: Number.isFinite(clock) ? Math.trunc(clock / 10) : row.source.vpos };
    const text = !originalOnly ? row.prepared : undefined;
    const decision: Decision = { sourceId: row.sourceId, originalText: row.originalText, text,
      resourceId: row.resourceId, adapterSession: row.adapterSession, owner: a,
      releasedAt: stamp(), expires: performance.now() + 20000, delivered: false };
    decisions.set(row.key, decision);
    trim();
    const failed = () => { if (!decision.delivered && decisions.get(row.key) === decision) decisions.delete(row.key); };
    try { void Promise.resolve(Reflect.apply(a.originalAdd, a.component, [copy, ...row.rest])).catch(failed); }
    catch { failed(); /* A failed native submission is neither a confirmed display nor an unsubmitted cancellation. */ }
  }
  function flush(reason: ResetReason | 'handoff') {
    for (const row of [...pending.values()]) { if (reason === 'handoff') release(row, true); else discard(row, reason); }
  }
  function restore() {
    cancelVisibleScan?.();
    const a = attachment; if (!a) return;
    for (const undo of a.restorers) { try { undo(); } catch { /* Site disposed this layer. */ } }
    attachment = null; decisions.clear();
  }
  function newSession(reason: ResetReason | 'handoff') {
    flush(reason); wire.clear(); sidebar.clear();
    // Same-room dedupe outlives generation changes. Submitted work keeps its original
    // identity until actual staging, expiry, or full hook restoration.
    adapterSession = crypto.randomUUID(); wasPlayable = false;
    trim();
  }
  function discover(): Native | null {
    const visited = new Set<object>();
    for (const element of document.querySelectorAll<HTMLElement>('div[id^="renderer-parent-id-"]')) {
      const key = Object.keys(element).find(k => /^__react(?:Fiber|InternalInstance)\$/.test(k));
      let fiber = key ? (element as Native)[key] : null;
      for (let depth = 0; fiber && depth < 20; depth++, fiber = fiber.return) {
        if (visited.has(fiber)) continue; visited.add(fiber);
        const c = fiber.stateNode, layers = c?.renderer?.layerProcessorList;
        if (c !== previousRoomComponent && typeof c?.addToRender === 'function' && typeof c.props?.getCurrentVposMs === 'function' && c.threadProcessor &&
          Array.isArray(layers) && layers.length > 0 && layers.length <= 10 && layers.every((l: Native) =>
            typeof l.addStagingFilter === 'function' && typeof l.removeStagingFilter === 'function' && typeof l.processor?.makeStagingSlot === 'function')) {
          return { component: c, renderer: c.renderer, thread: c.threadProcessor, layers: [...layers], element, originalAdd: c.addToRender, restorers: [] };
        }
      }
    }
    return null;
  }
  function attach(a: Native) {
    attachment = a;
    const descriptor = Object.getOwnPropertyDescriptor(a.component, 'addToRender');
    const wrapper = function(this: Native, chat: Native, ...rest: unknown[]) {
      if (!ordinary(chat)) return Reflect.apply(a.originalAdd, this, [chat, ...rest]);
      const key = keyOf(chat), meta = wire.get(key);
      if (!playable()) {
        seen.set(key, { text: chat.content, at: performance.now() }); trim();
        return Reflect.apply(a.originalAdd, this, [chat, ...rest]);
      }
      const sourceId = meta && meta.text === chat.content ? meta.id : key;
      if (seen.get(key)?.text === chat.content) return Promise.resolve();
      if (pending.size >= MAX_PENDING) {
        seen.set(key, { text: chat.content, at: performance.now() }); trim();
        post({ type: 'dropped', sourceId, reason: 'capacity' }); return Promise.resolve();
      }
      const receivedAt = stamp(), deadline = performance.now() + bufferMs;
      const eligible = needsTranslation(chat.content, targetLanguage, sourceLanguage) && !protectText(chat.content).reason;
      const row: Pending = { sourceId, key, source: { ...chat }, originalText: chat.content, rest, receivedAt, deadline,
        resourceId, adapterSession, released: false, eligible, retryAttempted: false, retrying: false,
        timer: setTimeout(() => retryOrRelease(row), bufferMs) };
      pending.set(sourceId, row); seen.set(key, { text: chat.content, at: performance.now() });
      sidebar.capture(sourceId, row.originalText);
      if (connection !== 'connected') { connection = 'connected'; snapshot(); }
      post({ type: 'events', events: [{ sourceId, originalText: row.originalText, receivedAt, scheduledAt: receivedAt,
        ...(meta && meta.text === chat.content ? { sentAtEpochMs: meta.sentAtEpochMs } : { sentAtEpochMs: chat.date * 1000 + Number(chat.date_usec ?? 0) / 1000 }), translatable: eligible }] });
      trim(); return Promise.resolve();
    };
    a.component.addToRender = wrapper;
    a.restorers.push(() => { if (a.component.addToRender === wrapper) { if (descriptor) Object.defineProperty(a.component, 'addToRender', descriptor); else delete a.component.addToRender; } });
    for (const layer of a.renderer.layerProcessorList as Native[]) {
      const filter = (chat: Native, settings: Native) => {
        const d = decisions.get(keyOf(chat));
        return playable() && d?.owner === a && d.resourceId === resourceId && d.adapterSession === adapterSession && settings.visible && d.text && settings.content === d.originalText
          ? { ...settings, content: d.text } : settings;
      };
      layer.addStagingFilter(FILTER, filter);
      a.restorers.push(() => layer.removeStagingFilter(FILTER));
      const processor = layer.processor, originalMake = processor.makeStagingSlot;
      const makeDescriptor = Object.getOwnPropertyDescriptor(processor, 'makeStagingSlot');
      const make = function(this: Native, slot: Native, chat: Native, settings: Native, ...rest: unknown[]) {
        const output = Reflect.apply(originalMake, this, [slot, chat, settings, ...rest]);
        const d = decisions.get(keyOf(chat));
        if (output && d?.owner === a && !d.delivered && nativeAlive(a)) {
          d.delivered = true;
          post({ type: 'delivered', sourceId: d.sourceId, resourceId: d.resourceId, adapterSession: d.adapterSession,
            translated: d.adapterSession === adapterSession && d.resourceId === resourceId && playable() && typeof d.text === 'string' && settings.content === d.text,
            displayAt: stamp(), releasedAt: d.releasedAt });
        }
        return output;
      };
      processor.makeStagingSlot = make;
      a.restorers.push(() => { if (processor.makeStagingSlot === make) { if (makeDescriptor) Object.defineProperty(processor, 'makeStagingSlot', makeDescriptor); else delete processor.makeStagingSlot; } });
    }
    snapshot();
  }
  /** Inspect the frame Pixi just drew, without calling draw/updateTransform ourselves. */
  function scanVisibleFrame(scanId: string) {
    const a = attachment, pixi = a?.renderer.pixiRenderer;
    const identity = { resourceId, adapterSession };
    type Rect = { left: number; top: number; right: number; bottom: number };
    const intersect = (a: Rect, b: Rect): Rect => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
    const area = (r: Rect) => Object.values(r).every(Number.isFinite) && r.right > r.left && r.bottom > r.top;
    const rectangle = (value: Native): Rect => ({ left: value.left ?? value.x, top: value.top ?? value.y,
      right: value.right ?? value.x + value.width, bottom: value.bottom ?? value.y + value.height });
    const send = (candidates: { sourceId: string; originalText: string }[], status: string) =>
      post({ type: 'repair-candidates', scope: 'visible', scanId, ...identity, candidates, status, chunkIndex: 0, done: true });
    if (!a || !nativeAlive(a) || typeof pixi?.on !== 'function' || typeof pixi?.off !== 'function') { send([], 'unavailable'); return; }
    cancelVisibleScan?.();
    let finished = false;
    const finish = (candidates: { sourceId: string; originalText: string }[], status: string) => {
      if (finished) return; finished = true; clearTimeout(timer); pixi.off('postrender', afterDraw);
      if (cancelVisibleScan === cancel) cancelVisibleScan = undefined;
      send(candidates, status);
    };
    const cancel = () => finish([], 'unavailable');
    const afterDraw = () => {
      if (pixi.renderingToScreen !== true || pixi._lastObjectRendered !== a.renderer.stage) return;
      if (!nativeAlive(a) || document.hidden || identity.adapterSession !== adapterSession || identity.resourceId !== resourceId) { cancel(); return; }
      try {
        const canvas = a.renderer.element;
        const screen = pixi.screen;
        if (!(canvas instanceof HTMLCanvasElement) || !canvas.isConnected || !screen || !(screen.width > 0 && screen.height > 0)) { cancel(); return; }
        const canvasRect = canvas.getBoundingClientRect();
        let clip = intersect(rectangle(canvasRect), { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
        for (let element: HTMLElement | null = canvas; element; element = element.parentElement) {
          const style = getComputedStyle(element);
          if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) <= 0) { finish([], 'supported'); return; }
          // Axis-aligned scale/translation is handled by DOM bounds. Unknown rotated,
          // perspective, CSS masks and clip paths cannot establish a reliable intersection.
          if (style.clipPath && style.clipPath !== 'none' || style.maskImage && style.maskImage !== 'none') { cancel(); return; }
          if (style.transform && style.transform !== 'none') {
            const matrix = new DOMMatrixReadOnly(style.transform);
            if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a <= 0 || matrix.d <= 0) { cancel(); return; }
          }
          const rect = rectangle(element.getBoundingClientRect());
          if (/(?:hidden|clip|scroll|auto)/.test(style.overflowX)) clip = { ...clip, left: Math.max(clip.left, rect.left), right: Math.min(clip.right, rect.right) };
          if (/(?:hidden|clip|scroll|auto)/.test(style.overflowY)) clip = { ...clip, top: Math.max(clip.top, rect.top), bottom: Math.min(clip.bottom, rect.bottom) };
        }
        if (!area(clip)) { finish([], 'supported'); return; }
        const drawable = (object: Native) => object && object.visible === true && object.renderable === true &&
          Number.isFinite(object.worldAlpha) && object.worldAlpha > 0 && !object.mask && !(object.filters?.length);
        const unknownEffect = (object: Native) => !!object?.mask || !!object?.filters?.length;
        const candidates: { sourceId: string; originalText: string }[] = [], ids = new Set<string>();
        let supported = 0, inspected = 0, chars = 0, partial = false;
        if (unknownEffect(a.renderer.stage)) { cancel(); return; }
        if (!drawable(a.renderer.stage)) { finish([], 'supported'); return; }
        for (const layer of a.layers) {
          const slots = layer.slotRepository?.stagingList, container = layer.displayObject;
          if (!Array.isArray(slots) || !container || container.parent !== a.renderer.stage) { partial = true; continue; }
          supported++;
          if (unknownEffect(container)) { partial = true; continue; }
          if (!drawable(container)) continue;
          for (let index = slots.length - 1; index >= 0; index--) {
            if (++inspected > 2000) { partial = true; break; }
            const slot = slots[index], object = slot?.displayObject;
            const raw = slot?.chat?.parsedOriginalChat ?? slot?.chat;
            if (unknownEffect(object)) { partial = true; continue; }
            if (!ordinary(raw) || !object || object.parent !== container || !drawable(object) || typeof object.getBounds !== 'function') continue;
            const bounds = object.getBounds(true);
            const rect = { left: canvasRect.left + (bounds.x - (screen.x ?? 0)) * canvasRect.width / screen.width,
              top: canvasRect.top + (bounds.y - (screen.y ?? 0)) * canvasRect.height / screen.height,
              right: canvasRect.left + (bounds.x + bounds.width - (screen.x ?? 0)) * canvasRect.width / screen.width,
              bottom: canvasRect.top + (bounds.y + bounds.height - (screen.y ?? 0)) * canvasRect.height / screen.height };
            if (!area(intersect(rect, clip))) continue;
            const key = keyOf(raw), sourceId = decisions.get(key)?.sourceId || wire.get(key)?.id || key;
            if (ids.has(sourceId) || sourceId.length > 300) continue;
            if (candidates.length >= 200 || chars + raw.content.length > 24000) { partial = true; continue; }
            ids.add(sourceId); chars += raw.content.length; candidates.push({ sourceId, originalText: raw.content });
          }
        }
        finish(candidates, !supported ? 'unavailable' : partial ? 'partial' : 'supported');
      } catch { cancel(); }
    };
    const timer = setTimeout(cancel, 1000);
    cancelVisibleScan = cancel; pixi.on('postrender', afterDraw);
  }
  // Observe the site's already-decoded Protobuf event, never its cookies, URLs or user IDs.
  let originalDispatch = EventTarget.prototype.dispatchEvent;
  const dispatch = function(this: EventTarget, event: Event) {
    try {
      if (enabled && resourceId && !suspended) {
        const detail = (event as CustomEvent).detail;
        if (event.type === 'onMessage' && detail?.message?.meta && detail.message.payload) {
          protocolTargets.add(this);
          if (connection !== 'connected') { connection = 'connected'; snapshot(); }
          const envelope = detail.message, payload = envelope.payload;
          if (payload.case === 'message' && payload.value?.data?.case === 'chat') {
            const chat = payload.value.data.value, at = envelope.meta.at;
            if (typeof envelope.meta.id === 'string' && envelope.meta.id.length <= 200 && typeof chat.content === 'string' && chat.content.length <= MAX_TEXT && at) {
              const date = Number(at.seconds), date_usec = Number(at.nanos) / 1000;
              wire.set(keyOf({ no: chat.no, date, date_usec }), { id: envelope.meta.id, text: chat.content,
                sentAtEpochMs: date * 1000 + date_usec / 1000, at: performance.now() }); trim();
            }
          }
        } else if (event.type === 'onError' && protocolTargets.has(this) && detail?.code !== 'AlreadyOpened') {
          connection = 'reconnecting'; newSession('session-reset'); snapshot();
        }
      }
    } catch { /* Observation must never interfere with the platform dispatcher. */ }
    return Reflect.apply(originalDispatch, this, [event]);
  };
  let observingProtocol = false;
  function syncProtocolObserver() {
    if (enabled && !observingProtocol) { originalDispatch = EventTarget.prototype.dispatchEvent; EventTarget.prototype.dispatchEvent = dispatch; observingProtocol = true; }
    else if (!enabled && observingProtocol) {
      if (EventTarget.prototype.dispatchEvent === dispatch) { EventTarget.prototype.dispatchEvent = originalDispatch; observingProtocol = false; }
    }
  }
  function onMessage(event: MessageEvent) {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (data?.bridge !== BRIDGE || data.from !== 'content') return;
    if (data.type === 'control' && typeof data.enabled === 'boolean' && validLiveBufferMs(data.bufferMs)) {
      lastLease = performance.now(); bufferMs = data.bufferMs;
      const nextTarget = typeof data.targetLanguage === 'string' && /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(data.targetLanguage) ? data.targetLanguage : targetLanguage;
      const nextSource = typeof data.sourceLanguage === 'string' && /^(auto|[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*)$/.test(data.sourceLanguage) ? data.sourceLanguage : sourceLanguage;
      const nextVersion = Number.isSafeInteger(data.configVersion) && data.configVersion >= 0 ? data.configVersion : configVersion;
      const changed = nextTarget !== targetLanguage || nextSource !== sourceLanguage || configVersion !== undefined && nextVersion !== configVersion;
      targetLanguage = nextTarget; sourceLanguage = nextSource; configVersion = nextVersion;
      timeoutRetryEnabled = data.niconicoTimeoutRetryEnabled === true; timeoutRetryExtraMs = data.niconicoTimeoutRetryExtraMs; timeoutRetryMode = data.niconicoTimeoutRetryMode;
      if (enabled && !data.enabled) { enabled = false; newSession('handoff'); restore(); }
      else {
        if (enabled && changed) { newSession('session-reset'); restore(); lastDiscovery = -Infinity; }
        enabled = data.enabled;
      }
      syncProtocolObserver();
      tick();
    } else if (data.type === 'repair-scan' && enabled && !suspended && nativeAlive() && data.platform === 'niconico' &&
        data.resourceId === resourceId && data.adapterSession === adapterSession && performance.now() - lastRepairScan >= 500) {
      lastRepairScan = performance.now();
      if (!['visible','queue','loaded'].includes(data.scope) || typeof data.scanId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(data.scanId)) return;
      if (data.scope === 'visible') { if (typeof data.scanId === 'string' && data.scanId.length <= 100) scanVisibleFrame(data.scanId); return; }
      // Read only the current native staging repositories. They are not a pixel-visibility oracle.
      const candidates: { sourceId: string; originalText: string; state?: string; text?: string }[] = [], ids = new Set<string>();
      let supported = 0, partial = false;
      for (const layer of attachment!.layers) {
        const slots = layer.slotRepository?.stagingList;
        if (!Array.isArray(slots)) continue;
        supported++;
        if (slots.length > 600) partial = true;
        for (const slot of slots.slice(-600)) {
          const raw = slot?.chat?.parsedOriginalChat ?? slot?.chat;
          if (!ordinary(raw)) continue;
          const key = keyOf(raw), decision = decisions.get(key), saved = wire.get(key), sourceId = decision?.sourceId || saved?.id || key;
          if (ids.has(sourceId) || sourceId.length > 300) continue;
          if (candidates.length >= 600) { partial = true; continue; }
          ids.add(sourceId); candidates.push({ sourceId, originalText: decision?.originalText ?? saved?.text ?? raw.content,
            ...(decision?.text ? { state: 'translated', text: decision.text } : {}) });
        }
      }
      for (let offset=0; offset<Math.max(1,candidates.length); offset+=100) post({ type: 'repair-candidates', scope: data.scope, scanId: data.scanId,
        chunkIndex: offset/100, done: offset+100>=candidates.length, candidates: candidates.slice(offset,offset+100),
        status: !supported ? 'unavailable' : !partial && supported === attachment!.layers.length ? 'supported' : 'partial' });
    } else if (data.type === 'repair-result' && playable() && data.platform === 'niconico' && data.resourceId === resourceId && data.adapterSession === adapterSession) {
      const row = pending.get(data.sourceId);
      if (!row || !row.retrying || row.retryRequestId !== data.requestId || row.released || performance.now() >= row.deadline) return;
      row.retrying = false; row.retryRequestId = undefined; clearTimeout(row.timer);
      if (['translated', 'cached'].includes(data.status) && typeof data.text === 'string' && data.text.trim() && data.text.length <= MAX_TEXT && !/[\r\n]/u.test(data.text)) {
        row.prepared = data.text;
        sidebar.translated(row.sourceId, row.originalText, data.text); sidebar.scan();
      }
      retryOrRelease(row);
    } else if (data.type === 'prepared' && playable() && data.platform === 'niconico' && data.resourceId === resourceId && data.adapterSession === adapterSession) {
      const row = pending.get(data.sourceId);
      if (row && !row.released && !row.retryAttempted && performance.now() < row.deadline && row.originalText === data.originalText &&
        typeof data.text === 'string' && !!data.text.trim() && data.text.length <= MAX_TEXT && !/[\r\n]/u.test(data.text)) {
        row.prepared = data.text;
        sidebar.translated(row.sourceId, row.originalText, data.text); sidebar.scan();
      }
    }
  }
  function tick() {
    if (stopped) return;
    const now = performance.now(), id = watchId();
    if (id !== resourceId) {
      previousRoomComponent = attachment?.component ?? previousRoomComponent;
      newSession('session-reset'); restore(); seen.clear(); resourceId = id; connection = 'connecting'; lastDiscovery = -Infinity;
    }
    if (enabled && now - lastLease > LEASE_MS) { enabled = false; newSession('handoff'); restore(); syncProtocolObserver(); }
    if (attachment && !nativeAlive()) { newSession('session-reset'); restore(); connection = 'connecting'; lastDiscovery = -Infinity; }
    if (enabled && !suspended && resourceId && !attachment && now - lastDiscovery > 1000) {
      lastDiscovery = now; const found = discover(); if (found) { newSession('session-reset'); attach(found); }
    }
    const active = playable();
    if (wasPlayable && !active) { newSession('inactive'); snapshot(); }
    wasPlayable = active;
    if (active) sidebar.scan();
    if (resourceId && now - lastSnapshot >= 1000) snapshot();
    trim();
  }
  const onHide = () => { suspended = true; newSession('session-reset'); restore(); };
  const onShow = () => { suspended = false; lastDiscovery = -Infinity; tick(); };
  const onVisibility = () => { if (document.hidden) { newSession('inactive'); snapshot(); } };
  window.addEventListener('message', onMessage);
  window.addEventListener('pagehide', onHide);
  window.addEventListener('pageshow', onShow);
  document.addEventListener('visibilitychange', onVisibility);
  const interval = setInterval(tick, 250);
  tick();
  const stop = () => {
    enabled = false; flush('handoff'); sidebar.clear(); restore(); stopped = true; clearInterval(interval);
    if (EventTarget.prototype.dispatchEvent === dispatch) EventTarget.prototype.dispatchEvent = originalDispatch;
    window.removeEventListener('message', onMessage); window.removeEventListener('pagehide', onHide);
    window.removeEventListener('pageshow', onShow); document.removeEventListener('visibilitychange', onVisibility);
    pending.clear(); decisions.clear(); seen.clear(); wire.clear();
    if (owner[OWNER] === stop) delete owner[OWNER];
  };
  owner[OWNER] = stop;
  return stop;
}
