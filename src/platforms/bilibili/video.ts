import { bilibiliSourceEventId, MAX_TEXT_LENGTH } from '../../core/messages.ts';
import type { AdapterDiagnostic, PlaybackClock, SourceMessage } from '../../core/types.ts';
import { SourcePublisher } from '../../core/source-stream.ts';
import { adapterDiagnostic, adapterDiagnosticText, DIAGNOSTIC_HEARTBEAT_MS, parseAdapterDiagnostic } from '../../core/adapter-diagnostic.ts';

/**
 * The bridge name is shared with the Niconico VOD adapter.  Keep the value
 * exact: the page/content bridge treats it as a protocol identifier.
 */
export const BRIDGE = 'danlingo.native.v1';
export const DANMAKU_VERSION = '1.1.24';
export const DANMAKU_LAST_COMPILED = '2026-09-10T15:18:49+08:00';
// A build is admitted only after its native filtering/measurement order is audited.
export const REVIEWED_DANMAKU_BUILDS = Object.freeze([
  Object.freeze({ version: DANMAKU_VERSION, lastCompiled: DANMAKU_LAST_COMPILED }),
  // Official core.5966babe.js observed on the user's page; static sources and
  // isolated real-page filter/on/initRender/model order audited 2026-09-21.
  Object.freeze({ version: '1.1.22', lastCompiled: '2026-07-14T14:26:03+08:00' }),
]);
export const ORDINARY_MODES = new Set([1, 4, 5, 6]);

type Native = Record<string, any>;
type MaybeRecord = Record<string, unknown>;

export interface BilibiliUrlIdentity {
  urlResourceId: string;
  page: number;
  bvid?: string;
  aid?: string;
}

export interface BilibiliNativeIdentity {
  resourceId: string;
  urlResourceId: string;
  aid: string;
  cid: string;
  page: number;
  bvid?: string;
}

export interface BilibiliNativeBinding {
  player: Native;
  danmaku: Native;
  manager: Native;
  video: Native;
  identity: BilibiliNativeIdentity;
}

export interface BilibiliAttachmentOptions {
  /** Test seam; production posts through window.postMessage. */
  post?: (payload: Record<string, unknown>) => void;
  /** Test seam; production uses performance.now(). */
  now?: () => number;
  /** Test seam for environments without a global queueMicrotask. */
  queueMicrotask?: (callback: () => void) => void;
}

export interface BilibiliAttachment {
  readonly session: string;
  readonly identity: BilibiliNativeIdentity;
  readonly binding: BilibiliNativeBinding;
  readonly epoch: number;
  readonly publisher: SourcePublisher;
  readonly prepared: Map<string, { text: string; originalText: string }>;
  readonly decisions: Map<string, { text: string | null; originalText: string }>;
  tick(): void;
  onMessage(event: MessageEvent | { data: unknown; source?: unknown; origin?: string }): void;
  stop(): { hookRestored: boolean; insertRestored: boolean; initRestored: boolean; laterWrapperPreserved: boolean };
}

function objectLike(value: unknown): value is Native {
  return !!value && typeof value === 'object';
}

function read(value: unknown, key: string): unknown {
  if (!objectLike(value)) return undefined;
  try { return value[key]; } catch { return undefined; }
}

function ownDescriptor(value: unknown, key: string): PropertyDescriptor | undefined {
  if (!objectLike(value)) return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key); } catch { return undefined; }
}

function safeDecimal(value: unknown, allowSafeNumber = true): string | null {
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) return null;
    const normalized = value.replace(/^0+(?=\d)/, '');
    return normalized || '0';
  }
  if (typeof value === 'bigint') return value >= 0n ? String(value) : null;
  if (allowSafeNumber && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function safePage(value: unknown): number | null {
  const text = safeDecimal(value);
  if (!text || !/^[1-9]\d{0,4}$/.test(text)) return null;
  const page = Number(text);
  return Number.isSafeInteger(page) ? page : null;
}

function nativeDmid(value: unknown): string | null {
  // A numeric dmid may already have lost precision.  Do not stringify it.
  return typeof value === 'string' && /^\d+$/.test(value) ? value : null;
}

function dmidFromItem(item: unknown): string | null {
  if (!objectLike(item)) return null;
  return nativeDmid(read(item, 'dmid')) ?? nativeDmid(read(item, 'id_str'));
}

function nativeMode(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10000 ? value : null;
}

/** Parse only the normal Bilibili video URL shape used by resourceFromUrl. */
export function parseBilibiliVideoUrl(value: string): BilibiliUrlIdentity | null {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://www.bilibili.com') return null;
    const match = /^\/video\/(BV[0-9A-Za-z]{10}|av[1-9]\d{0,19})\/?$/.exec(url.pathname);
    if (!match) return null;
    const id = match[1]!;
    const pageText = url.searchParams.get('p') ?? '1';
    const page = safePage(pageText);
    if (!page) return null;
    if (id.startsWith('BV')) return { urlResourceId: `${id}:p${page}`, page, bvid: id };
    return { urlResourceId: `${id}:p${page}`, page, aid: id.slice(2) };
  } catch { return null; }
}

/**
 * Public playback manifest, not URL metadata or private/account stores.
 * Verified with core.ba67b466.js and the current runtime on 2026-09-21.
 */
function resolveIdentity(player: Native, url: BilibiliUrlIdentity): BilibiliNativeIdentity | null {
  try {
    const getter = read(player, 'getManifest');
    if (typeof getter !== 'function') return null;
    const candidate = getter.call(player);
    const aid = safeDecimal(read(candidate, 'aid'));
    const cid = safeDecimal(read(candidate, 'cid'));
    const bvidValue = read(candidate, 'bvid');
    const bvid = typeof bvidValue === 'string' && /^BV[0-9A-Za-z]{10}$/.test(bvidValue) ? bvidValue : null;
    const page = safePage(read(candidate, 'p'));
    if (!aid || !cid || aid === '0' || cid === '0' || !page || page !== url.page) return null;
    // A URL candidate is not enough.  Match its identity field explicitly.
    if (url.bvid && bvid !== url.bvid) return null;
    if (url.aid && aid !== url.aid) return null;
    return {
      resourceId: `av${aid}:cid${cid}`,
      urlResourceId: url.urlResourceId,
      aid, cid, page,
      ...(bvid ? { bvid } : {}),
    };
  } catch { return null; }
}

function videoLike(value: unknown): value is Native {
  return objectLike(value) && typeof read(value, 'currentTime') === 'number' &&
    typeof read(value, 'paused') === 'boolean' && typeof read(value, 'playbackRate') === 'number';
}

function connected(value: Native): boolean {
  const state = read(value, 'isConnected');
  return state === undefined || state === true;
}

function findVideo(player: Native): Native | null {
  const getter = read(player, 'mediaElement');
  if (typeof getter === 'function') {
    try { const value = getter.call(player); if (videoLike(value) && connected(value)) return value; } catch { /* fail closed */ }
  }
  return null;
}

export function isReviewedDanmakuBuild(metadata: unknown): boolean {
  return REVIEWED_DANMAKU_BUILDS.some(build => read(metadata, 'version') === build.version && read(metadata, 'lastCompiled') === build.lastCompiled);
}

export function isSupportedDanmaku(instance: unknown): instance is Native {
  if (!objectLike(instance)) return false;
  let metadata: any;
  try { metadata = typeof instance.getMetadata === 'function' ? instance.getMetadata() : null; } catch { return false; }
  const hooks = read(instance, 'hooks');
  const manager = read(instance, 'manager');
  const descriptor = ownDescriptor(hooks, 'beforeRender');
  return isReviewedDanmakuBuild(metadata) &&
    objectLike(hooks) && !!descriptor && 'value' in descriptor && typeof descriptor.value === 'function' && descriptor.writable === true &&
    objectLike(manager) && Array.isArray(read(manager, 'visualArray')) && Array.isArray(read(read(manager, 'dataBase'), 'dmArray')) &&
    typeof read(manager, 'insert') === 'function' && typeof read(manager, 'initRender') === 'function';
}

/** Resolve the public player object and require a verified native identity. */
export function resolveBilibiliBinding(player: unknown, href: string): BilibiliNativeBinding | null {
  const url = parseBilibiliVideoUrl(href);
  if (!url || !objectLike(player)) return null;
  const danmakuApi = read(player, 'danmaku');
  const getter = read(danmakuApi, 'getDanmakuX');
  if (typeof getter !== 'function') return null;
  let danmaku: Native;
  try { danmaku = getter.call(danmakuApi); } catch { return null; }
  if (!isSupportedDanmaku(danmaku)) return null;
  const identity = resolveIdentity(player, url);
  const manager = read(danmaku, 'manager');
  const video = findVideo(player);
  if (!identity || !objectLike(manager) || !video) return null;
  return { player, danmaku, manager, video, identity };
}

/** The site's parsed timeline pool is manager.dataBase.dmArray; never read allDm/history. */
export function isOrdinaryDanmaku(item: unknown): item is Native {
  if (!objectLike(item)) return false;
  const text = read(item, 'text');
  const mode = nativeMode(read(item, 'mode'));
  const rawModeValue = read(item, 'rawMode');
  const rawMode = rawModeValue === undefined || rawModeValue === null ? mode : nativeMode(rawModeValue);
  const dmid = dmidFromItem(item);
  if (!dmid || typeof text !== 'string' || !text || text.length > MAX_TEXT_LENGTH || !text.trim() ||
      !mode || !ORDINARY_MODES.has(mode) || rawMode === null || !ORDINARY_MODES.has(rawMode)) return false;
  if (read(item, 'animation') || read(item, 'emoticons') || read(item, 'prefix') || read(item, 'suffix') ||
      read(item, 'resource') || read(item, 'resUrl') || read(item, 'colorfulImg') || read(item, 'colorful') ||
      read(item, 'likes') || read(item, 'isHighLike') || read(item, 'border') || read(item, 'pool') || read(item, 'action')) return false;
  return true;
}

function validDanmakuText(item: unknown): item is Native {
  if (!objectLike(item)) return false;
  const text = read(item, 'text');
  const stime = read(item, 'stime');
  return dmidFromItem(item) !== null && typeof text === 'string' && text.length > 0 &&
    text.length <= MAX_TEXT_LENGTH && typeof stime === 'number' && Number.isFinite(stime) && stime >= 0;
}

export function sourceMessageFromDanmaku(item: unknown, identity: BilibiliNativeIdentity): SourceMessage | null {
  if (!validDanmakuText(item)) return null;
  const dmid = dmidFromItem(item)!;
  const text = read(item, 'text') as string;
  const stime = read(item, 'stime') as number;
  const mode = nativeMode(read(item, 'mode'));
  if (mode === null) return null;
  const mediaTimeMs = stime * 1000;
  if (!Number.isFinite(mediaTimeMs) || mediaTimeMs < 0 || mediaTimeMs > 24 * 3600 * 1000) return null;
  const row: SourceMessage = {
    id: bilibiliSourceEventId(identity.resourceId, dmid), sourceId: dmid, platform: 'bilibili', resourceId: identity.resourceId,
    threadId: identity.cid, fork: 'main', originalText: text, mediaTimeMs, renderAtMs: mediaTimeMs,
    translatable: isOrdinaryDanmaku(item),
    style: { position: String(mode), size: String(read(item, 'size') ?? ''), color: String(read(item, 'color') ?? ''), font: String(read(item, 'font') ?? ''), commands: [] },
  };
  const date = read(item, 'date');
  const dateNumber = typeof date === 'number' && Number.isSafeInteger(date) ? date : null;
  if (dateNumber && dateNumber > 0) row.sentAtEpochMs = dateNumber > 1e12 ? dateNumber : dateNumber * 1000;
  return row;
}

export function sourceRowsFromPool(pool: unknown, identity: BilibiliNativeIdentity): SourceMessage[] {
  if (!Array.isArray(pool)) return [];
  const rows = new Map<string, SourceMessage>();
  for (const item of pool) {
    const row = sourceMessageFromDanmaku(item, identity);
    if (row && !rows.has(row.id)) rows.set(row.id, row);
  }
  return [...rows.values()].sort((a, b) => a.mediaTimeMs - b.mediaTimeMs || a.sourceId.localeCompare(b.sourceId));
}

/** A shallow object copy is the safe unit at manager.insert; nested native data stays untouched. */
export function clonePendingItems(pending: unknown[]): unknown[] {
  return pending.map(item => {
    if (!objectLike(item)) return item;
    const clone = Object.create(Object.getPrototypeOf(item));
    for (const key of Reflect.ownKeys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (descriptor) {
        try { Object.defineProperty(clone, key, descriptor); } catch { /* a malformed native object is left unchanged */ }
      }
    }
    return clone;
  });
}

function randomSession(): string {
  const value = (globalThis as any).crypto?.randomUUID?.();
  return typeof value === 'string' && value ? value : `bilibili-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

interface MethodRestore {
  wrapper: Function;
  restore(): boolean;
}

function installMethodWrapper(target: Native, key: string, makeWrapper: (original: Function) => Function): MethodRestore | null {
  const original = read(target, key);
  if (typeof original !== 'function') return null;
  const own = ownDescriptor(target, key);
  const wrapper = makeWrapper(original);
  try {
    if (own) {
      if (!('value' in own) || own.writable !== true) return null;
      Object.defineProperty(target, key, { ...own, value: wrapper });
      return { wrapper, restore: () => {
        if (read(target, key) !== wrapper) return false;
        Object.defineProperty(target, key, own);
        return true;
      } };
    }
    if (!Object.isExtensible(target)) return null;
    Object.defineProperty(target, key, { configurable: true, enumerable: false, writable: true, value: wrapper });
    return { wrapper, restore: () => {
      if (read(target, key) !== wrapper) return false;
      return delete target[key];
    } };
  } catch { return null; }
}

function surfaceFor(video: Native): Native | null {
  const doc = (globalThis as any).document;
  try {
    const element = doc?.querySelector?.('#playerWrap, .player-wrap');
    if (element) return element;
  } catch { /* optional marker only */ }
  return typeof video.closest === 'function' ? video.closest('[data-player-layout], .bpx-player-container') : null;
}

function setPlayerMarker(video: Native, session: string): Native | null {
  const surface = surfaceFor(video);
  const dataset = read(surface, 'dataset');
  if (objectLike(dataset)) { try { dataset.danlingoPlayer = session; } catch { /* optional marker */ } }
  return surface;
}

function removePlayerMarker(surface: Native | null, session: string): void {
  const dataset = read(surface, 'dataset');
  if (objectLike(dataset) && read(dataset, 'danlingoPlayer') === session) {
    try { delete dataset.danlingoPlayer; } catch { /* optional marker */ }
  }
}

function clockFor(video: Native, binding: BilibiliNativeBinding): PlaybackClock | null {
  const currentTime = read(video, 'currentTime');
  const duration = read(video, 'duration');
  const playbackRate = read(video, 'playbackRate');
  if (typeof currentTime !== 'number' || !Number.isFinite(currentTime) || typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 ||
      typeof playbackRate !== 'number' || !Number.isFinite(playbackRate)) return null;
  const buffered: { startMs: number; endMs: number }[] = [];
  const ranges: any = read(video, 'buffered');
  try {
    const length = Math.min(100, Number(ranges?.length) || 0);
    for (let i = 0; i < length; i++) {
      const start = Number(ranges.start(i)), end = Number(ranges.end(i));
      if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start) buffered.push({ startMs: start * 1000, endMs: end * 1000 });
    }
  } catch { /* optional buffered ranges */ }
  const active = connected(video) && read(video, 'ended') !== true &&
    parseBilibiliVideoUrl((globalThis as any).location?.href ?? '')?.urlResourceId === binding.identity.urlResourceId;
  return {
    mediaTimeMs: Math.max(0, currentTime * 1000), durationMs: duration * 1000,
    playbackRate: Math.max(0.1, Math.min(4, playbackRate)), paused: read(video, 'paused') === true,
    seeking: read(video, 'seeking') === true, contentActive: active, buffered,
  };
}

function sourceIdFrom(value: unknown): string | null {
  return dmidFromItem(value);
}

function writableText(item: Native): boolean {
  const descriptor = ownDescriptor(item, 'text');
  return !descriptor || ('value' in descriptor && descriptor.writable === true);
}

function sourceMatches(item: Native, row: SourceMessage): boolean {
  return sourceIdFrom(item) === row.sourceId && read(item, 'text') === row.originalText;
}

export function attachBilibiliNative(binding: BilibiliNativeBinding, options: BilibiliAttachmentOptions = {}): BilibiliAttachment {
  const now = options.now ?? (() => (globalThis as any).performance?.now?.() ?? Date.now());
  const session = randomSession();
  let epoch = 0, generation = 0, sourceGeneration = 0;
  let enabled = false, displayMode: 'translated' | 'original' = 'translated', receivedControl = false;
  const played: any = read(binding.video, 'played');
  let stopped = false, everPlayed = Number(played?.length) > 0 || read(binding.video, 'paused') === false;
  let lastLease = now(), lastSources = -Infinity, lastTime = Number(read(binding.video, 'currentTime')) * 1000 || 0, timeSample = now();
  let translated = 0, original = 0;
  const prepared = new Map<string, { text: string; originalText: string }>();
  const decisions = new Map<string, { text: string | null; originalText: string }>();
  const sourceRows = new Map<string, SourceMessage>();
  const insertStack: Set<unknown>[] = [];
  const originalHook = read(read(binding.danmaku, 'hooks'), 'beforeRender');
  const disposes: (() => void)[] = [];
  const marker = setPlayerMarker(binding.video, session);

  const emit = (payload: Record<string, unknown>) => {
    const message = { bridge: BRIDGE, from: 'native', platform: 'bilibili', session, epoch,
      resourceId: binding.identity.resourceId, urlResourceId: binding.identity.urlResourceId, ...payload };
    if (options.post) options.post(message);
    else (globalThis as any).window?.postMessage?.(message, (globalThis as any).location?.origin);
  };

  const publisher = new SourcePublisher(chunk => emit({ type: 'sources', sourceGeneration, ...chunk, collectionComplete: false }));

  function nextEpoch(): void {
    epoch++; decisions.clear(); translated = 0; original = 0;
    lastTime = Number(read(binding.video, 'currentTime')) * 1000 || 0; timeSample = now();
  }

  function collect(): SourceMessage[] {
    const rows = sourceRowsFromPool(read(read(binding.manager, 'dataBase'), 'dmArray'), binding.identity);
    sourceRows.clear(); for (const row of rows) sourceRows.set(row.id, row);
    for (const [id, value] of prepared) if (sourceRows.get(id)?.originalText !== value.originalText) prepared.delete(id);
    for (const id of decisions.keys()) if (!sourceRows.has(id)) decisions.delete(id);
    return rows;
  }

  function renderCopy(source: Native): Native {
    const id = sourceIdFrom(source);
    if (!id || !isOrdinaryDanmaku(source) || !writableText(source)) return source;
    // insert has already applied the original hook and filters and set on=true.
    // Never translate an existing active model or bypass that native admission.
    if (read(source, 'on') !== true || binding.manager.visualArray.some((model: Native) => sourceIdFrom(read(model, 'textData')) === id)) return source;
    const row = sourceRows.get(bilibiliSourceEventId(binding.identity.resourceId, id)) ?? sourceMessageFromDanmaku(source, binding.identity);
    if (!row || !sourceMatches(source, row) || !row.translatable) return source;
    const prior = decisions.get(row.id);
    if (prior && prior.originalText !== row.originalText) decisions.delete(row.id);
    const decision = decisions.get(row.id) ?? (() => {
      const ready = prepared.get(row.id);
      const text = ready && ready.originalText === row.originalText ? ready.text : null;
      const value = { text, originalText: row.originalText };
      decisions.set(row.id, value); if (text !== null) translated++; else original++;
      return value;
    })();
    if (!decision.text) return source;
    const on = ownDescriptor(source, 'on');
    if (!on || !('value' in on) || !on.writable || !on.configurable) return source;
    try {
      const copy = clonePendingItems([source])[0] as Native;
      copy.text = decision.text;
      // Native model destruction clears textData.on. Forward only that native
      // lifecycle flag so the real timeline does not lose its active state.
      Object.defineProperty(copy, 'on', { configurable: true, enumerable: on.enumerable,
        get: () => source.on, set: value => { source.on = value; } });
      return copy;
    } catch { return source; }
  }

  function currentInsertBinding(receiver: unknown): boolean {
    if (stopped || !enabled || displayMode !== 'translated' || receiver !== binding.manager) return false;
    const win = (globalThis as any).window;
    // attachBilibiliNative is also used by the deterministic unit harness,
    // which has no page window.  Production MAIN-world calls always have one,
    // and must revalidate the live player before cloning any pending object.
    if (!win) return true;
    const href = String(win.location?.href ?? '');
    const current = resolveBilibiliBinding(win.player, href);
    return !!current && current.player === binding.player && current.danmaku === binding.danmaku &&
      current.manager === binding.manager && current.video === binding.video &&
      current.identity.resourceId === binding.identity.resourceId && current.identity.urlResourceId === binding.identity.urlResourceId;
  }

  // Preserve native beforeRender, filtering and on admission on the ORIGINAL.
  // initRender is after those checks but before construction/measurement.
  const insertRestore = installMethodWrapper(binding.manager, 'insert', originalInsert => function (this: unknown, ...args: unknown[]) {
    const first = args[0];
    if (!Array.isArray(first) || !currentInsertBinding(this)) return Reflect.apply(originalInsert, this, args as any[]);
    insertStack.push(new Set(first));
    try { return Reflect.apply(originalInsert, this, args as any[]); }
    finally { insertStack.pop(); }
  });
  const initRestore = insertRestore && installMethodWrapper(binding.manager, 'initRender', nativeInit => function(this: unknown, ...args: unknown[]) {
    const source = args[0];
    if (objectLike(source) && insertStack.at(-1)?.has(source) && currentInsertBinding(this)) args[0] = renderCopy(source);
    return Reflect.apply(nativeInit, this, args as any[]);
  });
  if (!insertRestore || !initRestore) {
    insertRestore?.restore();
    throw new Error('Bilibili native insert/initRender boundary is not safely writable');
  }

  function getClock(): PlaybackClock | null { return clockFor(binding.video, binding); }

  function tick(): void {
    if (stopped) return;
    if (receivedControl && now() - lastLease > 6000) { enabled = false; }
    const clock = getClock();
    const current = Number(read(binding.video, 'currentTime')) * 1000;
    const rate = Number(read(binding.video, 'playbackRate')) || 1;
    const expected = lastTime + (read(binding.video, 'paused') === true ? 0 : (now() - timeSample) * rate);
    if (!read(binding.video, 'seeking') && Number.isFinite(current) && Math.abs(current - expected) > 1500) nextEpoch();
    lastTime = Number.isFinite(current) ? current : lastTime; timeSample = now();
    const rows = collect();
    if (!publisher.busy && now() - lastSources >= 1000) { lastSources = now(); publisher.update(rows, now()); }
    publisher.pump(now());
    if (clock) emit({ type: 'snapshot', clock, counts: { translated, original }, collectionComplete: false });
  }

  function onMessage(event: MessageEvent | { data: unknown; source?: unknown; origin?: string }): void {
    const d = event?.data as any;
    const win = (globalThis as any).window;
    const origin = (globalThis as any).location?.origin;
    if (event?.source !== undefined && event.source !== win) return;
    if (event?.origin !== undefined && event.origin !== origin) return;
    if (!d || d.bridge !== BRIDGE || d.from !== 'content' || d.session !== session || d.resourceId !== binding.identity.resourceId ||
        d.urlResourceId !== binding.identity.urlResourceId) return;
    if (d.type === 'control') {
      if (!Number.isSafeInteger(d.generation) || d.generation < generation) return;
      generation = d.generation; lastLease = now(); receivedControl = true;
      enabled = d.enabled === true; displayMode = d.displayMode === 'original' ? 'original' : 'translated';
      if (d.clear === true) { prepared.clear(); decisions.clear(); translated = 0; original = 0; }
      if (d.resync === true) { sourceGeneration = d.generation; publisher.reset(); lastSources = -Infinity; }
    } else if (d.type === 'sources-ack') {
      if (d.sourceGeneration === sourceGeneration && Number.isSafeInteger(d.revision) && Number.isSafeInteger(d.index)) publisher.acknowledge(d.revision, d.index, now());
    } else if (d.type === 'forget' && d.generation === generation && Array.isArray(d.ids)) {
      for (const id of d.ids.slice(0, 500)) if (typeof id === 'string') { prepared.delete(id); decisions.delete(id); }
    } else if (d.type === 'prepared' && d.generation === generation && enabled && Array.isArray(d.items)) {
      for (const item of d.items.slice(0, 200)) {
        if (!item || typeof item.id !== 'string' || item.id.length > 400 || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 2000 ||
            typeof item.originalText !== 'string' || item.originalText.length > MAX_TEXT_LENGTH) continue;
        const source = sourceRows.get(item.id);
        if (!source || source.originalText !== item.originalText) continue;
        prepared.set(item.id, { text: item.text, originalText: item.originalText });
        if (!everPlayed) decisions.delete(item.id);
      }
    }
  }

  const onSeeking = () => nextEpoch();
  const onPlaying = () => { everPlayed = true; };
  const addEvent = (type: string, callback: () => void) => {
    const add = read(binding.video, 'addEventListener');
    if (typeof add === 'function') {
      try {
        (add as Function).call(binding.video, type, callback);
        disposes.push(() => { try { const remove = read(binding.video, 'removeEventListener'); if (typeof remove === 'function') remove.call(binding.video, type, callback); } catch { /* disposed video */ } });
      } catch { /* optional lifecycle event */ }
    }
  };
  addEvent('seeking', onSeeking); addEvent('playing', onPlaying);

  const stop = () => {
    if (stopped) return { hookRestored: false, insertRestored: false, initRestored: false, laterWrapperPreserved: true };
    stopped = true; enabled = false; for (const dispose of disposes.splice(0)) dispose();
    removePlayerMarker(marker, session);
    const hookRestored = read(read(binding.danmaku, 'hooks'), 'beforeRender') === originalHook;
    const initRestored = initRestore.restore();
    const insertRestored = insertRestore.restore();
    return { hookRestored, insertRestored, initRestored, laterWrapperPreserved: !hookRestored || !insertRestored || !initRestored };
  };

  return { session, identity: binding.identity, binding, publisher, prepared, decisions, get epoch() { return epoch; }, tick, onMessage, stop };
}

export function bilibiliFailureDiagnostic(player: unknown, href: string): AdapterDiagnostic | null {
  const url = parseBilibiliVideoUrl(href);
  if (!url) return null;
  const diagnostic = adapterDiagnostic(url.urlResourceId, 'waiting-player');
  if (!objectLike(player) || typeof read(read(player, 'danmaku'), 'getDanmakuX') !== 'function') return diagnostic;
  try {
    const api = read(player, 'danmaku'), instance = (read(api, 'getDanmakuX') as Function).call(api);
    const metadata = typeof read(instance, 'getMetadata') === 'function' ? (read(instance, 'getMetadata') as Function).call(instance) : null;
    const safe = parseAdapterDiagnostic({ ...diagnostic, nativeVersion: metadata?.version, nativeCompiled: metadata?.lastCompiled }, url.urlResourceId)!;
    if (!isReviewedDanmakuBuild(metadata)) return { ...safe, code: 'unsupported-version' };
    if (!isSupportedDanmaku(instance)) return { ...safe, code: 'native-entry-unavailable' };
    if (!resolveIdentity(player, url)) return { ...safe, code: 'identity-mismatch' };
    if (!findVideo(player)) return { ...safe, code: 'native-entry-unavailable' };
    return { ...safe, code: 'invalid-clock' };
  } catch { return { ...diagnostic, code: 'native-entry-unavailable' }; }
}

/** Discover only the page's public player object; no global object/canvas/network patching. */
export function startBilibiliNativeBridge(): () => void {
  const win = (globalThis as any).window;
  if (!win) return () => {};
  const key = Symbol.for('danlingo.bilibili.video.stop');
  try { const previous = win[key]; if (typeof previous === 'function') previous(); } catch { /* stale instance */ }
  let current: BilibiliAttachment | null = null, stopped = false, suspended = false, lastUnavailable = '', lastUnavailableAt = -Infinity;
  const emitUnavailable = (diagnostic: AdapterDiagnostic | null) => {
    if (!diagnostic) return;
    const signature = JSON.stringify(diagnostic), now = performance.now();
    if (signature === lastUnavailable && now - lastUnavailableAt < DIAGNOSTIC_HEARTBEAT_MS) return;
    lastUnavailable = signature; lastUnavailableAt = now;
    win.postMessage({ bridge: BRIDGE, from: 'native', platform: 'bilibili', type: 'unavailable',
      urlResourceId: diagnostic.urlResourceId, diagnostic, reason: adapterDiagnosticText(diagnostic) }, win.location?.origin);
  };
  const disposeCurrent = () => { if (current) { current.stop(); current = null; } };
  const discover = () => {
    if (stopped || suspended) return;
    const href = String(win.location?.href ?? '');
    const binding = resolveBilibiliBinding(win.player, href);
    if (!binding) { disposeCurrent(); emitUnavailable(bilibiliFailureDiagnostic(win.player, href)); return; }
    if (!current || current.binding.player !== binding.player || current.binding.danmaku !== binding.danmaku || current.binding.manager !== binding.manager || current.binding.video !== binding.video ||
        current.identity.resourceId !== binding.identity.resourceId || current.identity.urlResourceId !== binding.identity.urlResourceId) {
      disposeCurrent();
      try { current = attachBilibiliNative(binding); } catch {
        emitUnavailable({ ...bilibiliFailureDiagnostic(win.player, href)!, code: 'native-entry-unavailable' }); return;
      }
    }
    if (!clockFor(binding.video, binding)) emitUnavailable(bilibiliFailureDiagnostic(win.player, href));
    else lastUnavailable = '';
    current.tick();
  };
  const timer = win.setInterval(discover, 250);
  const onMessage = (event: MessageEvent) => current?.onMessage(event);
  const onHide = () => { suspended = true; disposeCurrent(); };
  const onShow = () => { suspended = false; lastUnavailable = ''; discover(); };
  win.addEventListener?.('message', onMessage);
  win.addEventListener?.('pagehide', onHide);
  win.addEventListener?.('pageshow', onShow);
  const stop = () => {
    if (stopped) return;
    stopped = true; win.clearInterval(timer); disposeCurrent();
    win.removeEventListener?.('message', onMessage); win.removeEventListener?.('pagehide', onHide); win.removeEventListener?.('pageshow', onShow);
    try { if (win[key] === stop) delete win[key]; } catch { /* optional marker */ }
  };
  try { win[key] = stop; } catch { /* optional marker */ }
  discover();
  return stop;
}
