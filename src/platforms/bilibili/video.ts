import { bilibiliSourceEventId, MAX_TEXT_LENGTH } from '../../core/messages.ts';
import type { AdapterDiagnostic, PlaybackClock, SourceMessage } from '../../core/types.ts';
import { SourcePublisher, SOURCE_CHUNK_BYTES } from '../../core/source-stream.ts';
import { adapterDiagnostic, adapterDiagnosticText, DIAGNOSTIC_HEARTBEAT_MS, parseAdapterDiagnostic } from '../../core/adapter-diagnostic.ts';
import { VideoEligibilityPublisher } from '../video-eligibility.ts';
import { BilibiliUserFilterSession } from './user-filter-session.ts';
import { BilibiliShadowSession } from './shadow-session.ts';
import { BilibiliNativeSupply } from './native-supply.ts';
import { BilibiliOwnedRelease } from './owned-release.ts';
import { BilibiliOfficialObservation, type OfficialMode } from './official-observation.ts';
import type { createBilibiliShadowRules } from './shadow-rules.ts';

/**
 * The bridge name is shared with the Niconico VOD adapter.  Keep the value
 * exact: the page/content bridge treats it as a protocol identifier.
 */
export const BRIDGE = 'danlingo.native.v1';
export const BILIBILI_ADAPTER_SELECTION_PROBE = Symbol.for('danlingo.bilibili.adapter-selection.v1');
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
  /** Test seam; strict result deadlines use a wall-clock epoch across contexts. */
  epochNow?: () => number;
  /** Deterministic native fixture; production always reads the player rules. */
  shadowRules?: Pick<ReturnType<typeof createBilibiliShadowRules>, 'read'>;
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
  readonly nativeSupply: BilibiliNativeSupply;
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
    displayPlanEligible: mode === 1 && isOrdinaryDanmaku(item) && read(item, 'shooterType') !== 1,
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
  isCurrent(): boolean;
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
      return { wrapper, isCurrent: () => read(target, key) === wrapper, restore: () => {
        if (read(target, key) !== wrapper) return false;
        Object.defineProperty(target, key, own);
        return true;
      } };
    }
    if (!Object.isExtensible(target)) return null;
    Object.defineProperty(target, key, { configurable: true, enumerable: false, writable: true, value: wrapper });
    return { wrapper, isCurrent: () => read(target, key) === wrapper, restore: () => {
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

/** Read the observed native switch inside this video's player, not its static checked attribute. */
export function readBilibiliDanmakuVisibility(video: unknown): boolean | null {
  if (!objectLike(video) || read(video, 'isConnected') !== true) return null;
  try {
    const closest = read(video, 'closest');
    if (typeof closest !== 'function') return null;
    const root = closest.call(video, '.bpx-player-container');
    if (!objectLike(root) || read(root, 'isConnected') !== true || typeof read(root, 'contains') !== 'function' || !root.contains(video)) return null;
    const query = read(root, 'querySelectorAll');
    if (typeof query !== 'function') return null;
    const switches = query.call(root, '.bpx-player-dm-switch input.bui-danmaku-switch-input[type="checkbox"]');
    if (switches?.length !== 1) return null;
    const control = switches[0];
    const checked = read(control, 'checked');
    if (read(control, 'isConnected') !== true || read(control, 'disabled') !== false || typeof checked !== 'boolean') return null;
    const getAttribute = read(control, 'getAttribute');
    if (typeof getAttribute !== 'function') return null;
    const aria = getAttribute.call(control, 'aria-checked');
    if (aria !== null && aria !== String(checked)) return null;
    return checked;
  } catch { return null; }
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
  const epochNow = options.epochNow ?? (() => Date.now());
  const session = randomSession();
  let epoch = 0, generation = 0, sourceGeneration = 0;
  let enabled = false, displayMode: 'translated' | 'original' = 'translated', receivedControl = false;
  const played: any = read(binding.video, 'played');
  let stopped = false, everPlayed = Number(played?.length) > 0 || read(binding.video, 'paused') === false;
  let lastLease = now(), lastSources = -Infinity, lastTime = Number(read(binding.video, 'currentTime')) * 1000 || 0, timeSample = now();
  const playbackAdvancing = () => read(binding.video, 'paused') === false &&
    read(binding.video, 'seeking') !== true && Number(read(binding.video, 'readyState')) >= 3;
  let lastAdvancing = playbackAdvancing();
  let translated = 0, original = 0;
  let shadow: BilibiliShadowSession | null = null;
  let owned: BilibiliOwnedRelease | null = null;
  let officialObservation: BilibiliOfficialObservation | null = null;
  let officialOwnsPage = false;
  let shadowReference = false;
  let shadowUpdateRevision = 0;
  let userFilterPlayback: { time: number; paused: boolean } | null = null;
  let userFilterObservation = { started: false, playing: false, restored: true, selectedRuleHit: false };
  let displayPlanPlayback: { time: number; paused: boolean; rate?: number; externalChange?: boolean } | null = null;
  let removeRenderPlaybackListeners = () => {};
  const displayPlanObservation: { started: boolean; restored: boolean; seekCount: number;
    owner?: string; restoreDisposition?: string; playbackListeners?: number } = { started: false, restored: true, seekCount: 0 };
  const prepared = new Map<string, { text: string; originalText: string }>();
  const decisions = new Map<string, { text: string | null; originalText: string }>();
  const sourceRows = new Map<string, SourceMessage>();
  const insertStack: { pending: Set<unknown>; suppressed: Set<Native>; supplied: Map<Native, {
    source: { id: string | null; sourceId: string | null; originalText: string | null; mode: number | null;
      canReplace: boolean; epoch: number; mediaTimeMs: number }; wasOn: unknown }>; initialized: Set<Native> }[] = [];
  const fetchStack: { currentTime: number; preTime: number; rate: number }[] = [];
  const observedModels = new Map<Native, { id: string | null; sourceId: string | null; epoch: number;
    mediaTimeMs: number | null; accepted: boolean; sampled: boolean; restore: MethodRestore | null }>();
  const originalHook = read(read(binding.danmaku, 'hooks'), 'beforeRender');
  const disposes: (() => void)[] = [];
  const marker = setPlayerMarker(binding.video, session);

  const emit = (payload: Record<string, unknown>) => {
    const message = { bridge: BRIDGE, from: 'native', platform: 'bilibili', session, epoch,
      resourceId: binding.identity.resourceId, urlResourceId: binding.identity.urlResourceId, ...payload };
    if (options.post) options.post(message);
    else (globalThis as any).window?.postMessage?.(message, (globalThis as any).location?.origin);
  };

  const nativeSupply = new BilibiliNativeSupply({ resourceId: binding.identity.resourceId, session, now, epochNow,
    emit: event => emit({ type: 'bilibili-native-supply-event', event }),
    pause: () => { if (typeof binding.video.pause !== 'function') throw new Error('native-supply-pause-unavailable'); binding.video.pause(); } });

  const userFilters = new BilibiliUserFilterSession({ player: binding.player, danmaku: binding.danmaku,
    documentScope: session, now, emit: payload => emit({ sourceGeneration, ...payload }) });
  const nativePool = () => read(read(binding.manager, 'dataBase'), 'dmArray') as unknown[];
  // Each judgment repeats source fields; half the budget covers that copy and 16 KiB covers the envelope.
  const sourceByteLimit = SOURCE_CHUNK_BYTES / 2 - 16 * 1024;
  const publisher = new SourcePublisher(chunk => emit({ type: 'sources', sourceGeneration, ...chunk, collectionComplete: false,
    userFilter: userFilters.forSources(chunk.upserts, nativePool()) }), sourceByteLimit);
  const eligibility = new VideoEligibilityPublisher(update => emit({ type: 'video-eligibility', sourceGeneration, ...update }));
  eligibility.reset();

  function nextEpoch(): void {
    epoch++; decisions.clear(); translated = 0; original = 0; eligibility.reset(); userFilters.invalidate();
    nativeSupply.invalidate('playback-epoch');
    lastTime = Number(read(binding.video, 'currentTime')) * 1000 || 0; timeSample = now();
    lastAdvancing = playbackAdvancing();
  }

  function collect(): SourceMessage[] {
    const rows = sourceRowsFromPool(read(read(binding.manager, 'dataBase'), 'dmArray'), binding.identity);
    sourceRows.clear(); for (const row of rows) sourceRows.set(row.id, row);
    for (const [id, value] of prepared) if (sourceRows.get(id)?.originalText !== value.originalText) prepared.delete(id);
    for (const id of decisions.keys()) if (!sourceRows.has(id)) decisions.delete(id);
    return rows;
  }

  function copyWithText(source: Native, text: string): Native {
    const on = ownDescriptor(source, 'on');
    if (!on || !('value' in on) || !on.writable || !on.configurable || !writableText(source)) return source;
    try {
      const copy = clonePendingItems([source])[0] as Native;
      copy.text = text;
      // Native model destruction must release the original timeline object.
      Object.defineProperty(copy, 'on', { configurable: true, enumerable: on.enumerable,
        get: () => source.on, set: value => { source.on = value; } });
      return copy;
    } catch { return source; }
  }

  function supplySource(source: Native, beforeAdmission = false) {
    const sourceId = sourceIdFrom(source);
    const row = sourceId ? sourceRows.get(bilibiliSourceEventId(binding.identity.resourceId, sourceId)) ??
      sourceMessageFromDanmaku(source, binding.identity) : null;
    const on = ownDescriptor(source, 'on');
    // Fresh parser/Worker rows have no `on` field. Native insert accepts that
    // falsy state and creates an own data property on admission. Do not mutate
    // the pool here or relax the post-admission descriptor/lifecycle check.
    let creatableOn = false;
    if (beforeAdmission && !on) try {
      creatableOn = !('on' in source) && Object.isExtensible(source);
    } catch { /* Unknown objects cannot acquire a reviewed native lifecycle. */ }
    return { id: row?.id ?? (sourceId && bilibiliSourceEventId(binding.identity.resourceId, sourceId)),
      sourceId, originalText: typeof read(source, 'text') === 'string' ? source.text : null,
      mode: nativeMode(read(source, 'mode')),
      canReplace: !!row && sourceMatches(source, row) && isOrdinaryDanmaku(source) && writableText(source) &&
        (creatableOn || !!on && 'value' in on && on.writable === true && on.configurable === true) &&
        !binding.manager.visualArray.some((model: Native) => sourceIdFrom(read(model, 'textData')) === sourceId),
      epoch, mediaTimeMs: typeof read(source, 'stime') === 'number' ? source.stime * 1000 : NaN };
  }

  function ownedHooksCurrent(): boolean {
    return insertRestore?.isCurrent() === true && initRestore?.isCurrent() === true && fetchRestore?.isCurrent() === true &&
      validateRestore?.isCurrent() === true && read(read(binding.danmaku, 'hooks'), 'beforeRender') === originalHook;
  }

  function renderCopy(source: Native): Native {
    const id = sourceIdFrom(source);
    if (!id || !isOrdinaryDanmaku(source) || !writableText(source)) return source;
    // insert has already applied the original hook and filters and set on=true.
    // Never translate an existing active model or bypass that native admission.
    if (read(source, 'on') !== true || binding.manager.visualArray.some((model: Native) => sourceIdFrom(read(model, 'textData')) === id)) return source;
    const row = sourceRows.get(bilibiliSourceEventId(binding.identity.resourceId, id)) ?? sourceMessageFromDanmaku(source, binding.identity);
    if (!row || !sourceMatches(source, row) || !row.translatable) return source;
    if (userFilters.decision(row).state === 'exclude') return source;
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
    return copyWithText(source, decision.text);
  }

  function currentInsertBinding(receiver: unknown): boolean {
    if (stopped || receiver !== binding.manager ||
      (!nativeSupply.active && (!enabled || displayMode !== 'translated'))) return false;
    const win = (globalThis as any).window;
    // attachBilibiliNative is also used by the deterministic unit harness,
    // which has no page window.  Production MAIN-world calls always have one,
    // and must revalidate the live player before cloning any pending object.
    if (!win) return true;
    const href = String(win.location?.href ?? '');
    const current = resolveBilibiliBinding(win.player, href);
    const valid = !!current && current.player === binding.player && current.danmaku === binding.danmaku &&
      current.manager === binding.manager && current.video === binding.video &&
      current.identity.resourceId === binding.identity.resourceId && current.identity.urlResourceId === binding.identity.urlResourceId;
    if (!valid && nativeSupply.active) nativeSupply.fail('native-binding-changed');
    return valid || nativeSupply.active;
  }

  function sampleModel(model: Native): void {
    const record = observedModels.get(model);
    if (!record || record.sampled || !nativeSupply.active) return;
    const element = read(model, 'element'), container = read(binding.manager, 'container');
    if (!objectLike(element) || typeof read(element, 'getBoundingClientRect') !== 'function' ||
      !objectLike(container) || typeof read(container, 'getBoundingClientRect') !== 'function') return;
    try {
      const a = element.getBoundingClientRect(), b = container.getBoundingClientRect();
      const intersection = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
        Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      const style = (globalThis as any).getComputedStyle?.(element);
      record.sampled = true;
      nativeSupply.event('domSample', record.id, record.sourceId, record.epoch, record.mediaTimeMs,
        intersection > 0 ? 'geometry-intersects-player' : 'outside-player', false,
        { text: typeof read(element, 'textContent') === 'string' ? element.textContent.slice(0, 2000) : undefined,
          nativeResult: intersection > 0 && style?.visibility !== 'hidden' && style?.display !== 'none' && style?.opacity !== '0' });
    } catch { /* DOM sampling is evidence, never a rendering decision. */ }
  }

  function observeCreatedModels(before: Set<unknown>, source: Native, row: SourceMessage | null): void {
    const id = row?.id ?? (sourceIdFrom(source) && bilibiliSourceEventId(binding.identity.resourceId, sourceIdFrom(source)!));
    const sourceId = sourceIdFrom(source);
    const mediaTimeMs = typeof read(source, 'stime') === 'number' ? source.stime * 1000 : null;
    const models = [...(Array.isArray(binding.manager.cDmlist) ? binding.manager.cDmlist : []),
      ...(Array.isArray(binding.manager.visualArray) ? binding.manager.visualArray : [])];
    for (const model of models) {
      if (!objectLike(model) || before.has(model) || observedModels.has(model) || sourceIdFrom(read(model, 'textData')) !== sourceId) continue;
      const record = { id: id ?? null, sourceId, epoch, mediaTimeMs, accepted: false, sampled: false,
        restore: null as MethodRestore | null };
      observedModels.set(model, record);
      nativeSupply.event('nativeModel', record.id, sourceId, epoch, mediaTimeMs);
      record.restore = installMethodWrapper(model, 'firstShow', original => function (this: unknown, ...args: unknown[]) {
        const result = Reflect.apply(original, this, args as any[]);
        if (this === model) {
          nativeSupply.event('nativeFirstShow', record.id, sourceId, record.epoch, mediaTimeMs);
          sampleModel(model);
        }
        return result;
      });
    }
  }

  function inspectModels(): void {
    if (!nativeSupply.active) return;
    const pending = new Set(Array.isArray(binding.manager.cDmlist) ? binding.manager.cDmlist : []);
    const visual = new Set(Array.isArray(binding.manager.visualArray) ? binding.manager.visualArray : []);
    for (const [model, record] of observedModels) {
      if (visual.has(model) && !record.accepted) {
        record.accepted = true;
        nativeSupply.event('trackAccepted', record.id, record.sourceId, record.epoch, record.mediaTimeMs);
      }
      if (visual.has(model)) sampleModel(model);
      if (!pending.has(model) && !visual.has(model)) {
        if (!record.accepted && record.epoch === epoch && read(read(model, 'textData'), 'on') === false)
          nativeSupply.event('trackRejected', record.id, record.sourceId, record.epoch, record.mediaTimeMs,
            'removed-before-visual-array');
        record.restore?.restore(); observedModels.delete(model);
      }
    }
  }

  // Preserve native beforeRender, filtering and on admission on the ORIGINAL.
  // initRender is after those checks but before construction/measurement.
  const insertRestore = installMethodWrapper(binding.manager, 'insert', originalInsert => function (this: unknown, ...args: unknown[]) {
    const first = args[0];
    if (!Array.isArray(first)) {
      if (nativeSupply.active && this === binding.manager) {
        nativeSupply.fail('native-insert-shape-changed'); return undefined;
      }
      return Reflect.apply(originalInsert, this, args as any[]);
    }
    if (!currentInsertBinding(this)) return Reflect.apply(originalInsert, this, args as any[]);
    if (nativeSupply.active && nativeSupply.policy === 'owned') {
      if (!ownedHooksCurrent()) nativeSupply.fail('owned-hook-ownership-lost');
      if (nativeSupply.running) try { owned?.tick(epoch); } catch { nativeSupply.fail('owned-observation-failed'); }
      const batch = fetchStack.at(-1);
      const currentTime = batch?.currentTime ?? binding.video.currentTime;
      const preTime = batch?.preTime ?? binding.manager.config?.setting?.preTime;
      const rate = batch?.rate ?? binding.video.playbackRate;
      const inWindow = (item: Native) => typeof item.stime === 'number' &&
        item.stime >= currentTime - .001 && item.stime <= currentTime + preTime * rate - .001;
      const candidates = !nativeSupply.running ? [] :
        batch ? owned?.candidates(currentTime, preTime, rate) ?? [] : first;
      const selected: Native[] = [];
      const seen = new Set<Native>();
      for (const item of candidates) if (objectLike(item) && ORDINARY_MODES.has(nativeMode(read(item, 'mode')) ?? -1) && !seen.has(item)) {
        seen.add(item);
        const source = supplySource(item, true);
        const reason = !owned?.active ? owned?.report().reason ?? 'owned-control-unavailable' :
          !owned.matches(item) ? 'not-owned' : !inWindow(item) ? 'outside-preparation-window' :
          read(item, 'on') ? 'already-active' :
          nativeSupply.preflight(source).reason;
        if (reason === 'qualified-result' || reason === 'classified-no-translation') selected.push(item);
        else if (owned?.matches(item) && inWindow(item)) {
          owned.markSuppressed(item); nativeSupply.closeOwnedSuppressed(source, reason);
        } else nativeSupply.event('ownedSuppressed', source.id, source.sourceId, epoch, source.mediaTimeMs,
          reason, false, source.originalText === null ? {} : { originalText: source.originalText });
      }
      // A formal native fetch supplies the owned rows even when the native
      // range query chose a different ordinary set. Special modes remain native.
      args[0] = [...first.filter(item => !objectLike(item) || !ORDINARY_MODES.has(nativeMode(read(item, 'mode')) ?? -1)), ...selected];
    }
    const pending = args[0] as unknown[];
    const frame = { pending: new Set(pending), suppressed: new Set<Native>(),
      supplied: new Map<Native, { source: ReturnType<typeof supplySource>; wasOn: unknown }>(),
      initialized: new Set<Native>() };
    if (nativeSupply.active && nativeSupply.policy === 'owned') for (const item of pending) if (objectLike(item) &&
      ORDINARY_MODES.has(nativeMode(read(item, 'mode')) ?? -1)) {
      frame.supplied.set(item, { source: supplySource(item), wasOn: read(item, 'on') }); owned?.markSupplied(item);
    }
    insertStack.push(frame);
    if (nativeSupply.active && shadow) try { shadow.tick(epoch); }
    catch { nativeSupply.fail('shadow-observation-failed'); }
    if (nativeSupply.active) for (const item of pending) if (objectLike(item)) {
      const sourceId = sourceIdFrom(item);
      nativeSupply.event('candidate', sourceId ? bilibiliSourceEventId(binding.identity.resourceId, sourceId) : null,
        sourceId, epoch, typeof read(item, 'stime') === 'number' ? item.stime * 1000 : null);
    }
    try { return Reflect.apply(originalInsert, this, args as any[]); }
    finally {
      insertStack.pop();
      for (const item of frame.suppressed) if (read(item, 'on') === true) {
        try { item.on = false; } catch { nativeSupply.fail('native-on-release-failed'); }
      }
      for (const [item, entry] of frame.supplied) if (!frame.initialized.has(item)) {
        nativeSupply.closeNativeRejected(entry.source);
        if (entry.wasOn === false && read(item, 'on') === true)
          try { item.on = false; } catch { nativeSupply.fail('native-on-release-failed'); }
      }
    }
  });
  const initRestore = insertRestore && installMethodWrapper(binding.manager, 'initRender', nativeInit => function(this: unknown, ...args: unknown[]) {
    const source = args[0];
    const frame = insertStack.at(-1);
    const inNativeInsert = objectLike(source) && frame?.pending.has(source) && currentInsertBinding(this);
    const sourceId = objectLike(source) ? sourceIdFrom(source) : null;
    const row = sourceId && objectLike(source)
      ? sourceRows.get(bilibiliSourceEventId(binding.identity.resourceId, sourceId)) ?? sourceMessageFromDanmaku(source, binding.identity)
      : null;
    const mediaTimeMs = objectLike(source) && typeof read(source, 'stime') === 'number' ? source.stime * 1000 : null;
    if (inNativeInsert && objectLike(source)) {
      const supplied = frame?.supplied.get(source);
      if (nativeSupply.active && nativeSupply.policy === 'owned' && supplied && !owned?.matchesAdmission(source)) {
        // Never let a transformed ordinary event escape via the out-of-scope
        // path, or adopt text under an identity changed by an unexpected hook.
        nativeSupply.closeOwnedSuppressed(supplied.source, 'native-preparation-mismatch');
        frame?.suppressed.add(source); frame?.initialized.add(source);
        return undefined;
      }
      if (row && row.translatable && sourceMatches(source, row) && read(source, 'on') === true)
        eligibility.observe(row.id, row.originalText, 'eligible');
      if (nativeSupply.active) {
        let strictCopy: Native = source;
        const admittedSource = supplySource(source);
        const selection = nativeSupply.select({ ...admittedSource,
          canReplace: admittedSource.canReplace && read(source, 'on') === true,
          adopt: text => { strictCopy = copyWithText(source, text); return strictCopy !== source; } });
        if (selection.choice === 'untranslated-needed' || selection.choice === 'duplicate') {
          frame?.suppressed.add(source);
          return undefined;
        }
        if (selection.choice === 'adopted') args[0] = strictCopy;
      } else args[0] = renderCopy(source);
    } else if (nativeSupply.active && this === binding.manager &&
      (!objectLike(source) || ORDINARY_MODES.has(nativeMode(read(source, 'mode')) ?? -1))) {
      nativeSupply.fail('init-outside-reviewed-insert');
      if (objectLike(source)) {
        if (frame) frame.suppressed.add(source);
        else try { source.on = false; } catch { /* pause is already requested */ }
      }
      nativeSupply.event('suppressed', row?.id ?? null, sourceId, epoch, mediaTimeMs,
        'init-outside-reviewed-insert', true);
      return undefined;
    }
    if (this === binding.manager && objectLike(source)) {
      try {
        const selectionProbe = (globalThis as any)[BILIBILI_ADAPTER_SELECTION_PROBE];
        const dmid = typeof selectionProbe === 'function' ? sourceIdFrom(source) : null;
        const originalText = dmid ? read(source, 'text') : null;
        if (dmid && typeof originalText === 'string' && originalText.length <= MAX_TEXT_LENGTH) {
          const id = bilibiliSourceEventId(binding.identity.resourceId, dmid);
          const decision = decisions.get(id);
          const selectedTranslation = args[0] !== source;
          selectionProbe(source, {
            source: { id, dmid, originalText },
            adapterSession: session, epoch, selectedTranslation,
            choice: selectedTranslation ? 'translated' : 'original', selectedAtMs: now(),
            preparedIdentity: selectedTranslation && decision ? {
              id, originalText: decision.originalText, text: decision.text,
            } : null,
          });
        }
      } catch { /* An opt-in observer must not change native rendering. */ }
    }
    if (nativeSupply.active && this === binding.manager && objectLike(source))
      nativeSupply.event('nativeInitRender', row?.id ?? null, sourceId, epoch, mediaTimeMs,
        args[0] === source ? 'original-or-out-of-scope' : 'translated');
    if (frame && objectLike(source)) frame.initialized.add(source);
    if (this === binding.manager) try { shadow?.recordNativeInit(source); } catch { /* passive observation */ }
    const before = nativeSupply.active && this === binding.manager ? new Set([
      ...(Array.isArray(binding.manager.cDmlist) ? binding.manager.cDmlist : []),
      ...(Array.isArray(binding.manager.visualArray) ? binding.manager.visualArray : []),
    ]) : null;
    try {
      const result = Reflect.apply(nativeInit, this, args as any[]);
      if (before && objectLike(source)) observeCreatedModels(before, source, row);
      return result;
    } catch (error) {
      if (nativeSupply.active) {
        nativeSupply.event('nativeInitError', row?.id ?? null, sourceId, epoch, mediaTimeMs);
        nativeSupply.fail('native-init-threw');
      }
      throw error;
    } finally {
      if (this === binding.manager) try { shadow?.afterNativeInit(); } catch { /* passive observation */ }
    }
  });
  const fetchRestore = installMethodWrapper(binding.manager, 'fetchAndInitDm', originalFetch => function (this: unknown, ...args: unknown[]) {
    if (this !== binding.manager || nativeSupply.policy !== 'owned' || !nativeSupply.active)
      return Reflect.apply(originalFetch, this, args as any[]);
    const currentTime = Number(read(binding.video, 'currentTime'));
    const preTime = Number(read(read(read(binding.manager, 'config'), 'setting'), 'preTime'));
    const rate = Number(read(binding.video, 'playbackRate'));
    fetchStack.push({ currentTime, preTime, rate });
    try { return Reflect.apply(originalFetch, this, args as any[]); }
    finally { fetchStack.pop(); }
  });
  const validateRestore = installMethodWrapper(binding.manager, 'validate', original => function (this: unknown, ...args: unknown[]) {
    const result = Reflect.apply(original, this, args as any[]);
    if (nativeSupply.active && this === binding.manager) {
      const item = args[0], sourceId = sourceIdFrom(item);
      nativeSupply.event('nativeValidate', sourceId ? bilibiliSourceEventId(binding.identity.resourceId, sourceId) : null,
        sourceId, epoch, typeof read(item, 'stime') === 'number' ? (read(item, 'stime') as number) * 1000 : null,
        undefined, undefined, { nativeResult: result === true });
    }
    return result;
  });
  if (!insertRestore || !initRestore) {
    insertRestore?.restore();
    throw new Error('Bilibili native insert/initRender boundary is not safely writable');
  }

  function getClock(): PlaybackClock | null { return clockFor(binding.video, binding); }

  function tick(): void {
    if (stopped) return;
    if (owned && !ownedHooksCurrent()) nativeSupply.fail('owned-hook-ownership-lost');
    if (receivedControl && now() - lastLease > 6000) {
      if (nativeSupply.active) nativeSupply.fail('control-lease-expired');
      enabled = false; shadow?.stop(); shadow = null; owned?.stop(); owned = null;
    }
    const commentsVisible = readBilibiliDanmakuVisibility(binding.video);
    eligibility.setDisplay(commentsVisible === null ? 'unknown' : commentsVisible ? 'visible' : 'hidden');
    const clock = getClock();
    if (clock && commentsVisible !== null) clock.commentsVisible = commentsVisible;
    const current = Number(read(binding.video, 'currentTime')) * 1000;
    const rate = Number(read(binding.video, 'playbackRate')) || 1;
    const advancing = playbackAdvancing();
    const expected = lastTime + (lastAdvancing && advancing ? (now() - timeSample) * rate : 0);
    if (!read(binding.video, 'seeking') && Number.isFinite(current) && Math.abs(current - expected) > 1500) nextEpoch();
    lastTime = Number.isFinite(current) ? current : lastTime; timeSample = now();
    lastAdvancing = advancing;
    const rows = officialOwnsPage ? [] : collect();
    userFilters.refresh(rows, nativePool());
    if (nativeSupply.running || nativeSupply.planned && nativeSupply.paused &&
        nativeSupply.fault?.startsWith('owned-')) {
      let observed = true;
      try { owned?.tick(epoch); } catch { observed = false; nativeSupply.fail('owned-observation-failed'); }
      if (observed && nativeSupply.planned && nativeSupply.paused && owned?.active && ownedHooksCurrent() &&
          nativeSupply.fault?.startsWith('owned-'))
        nativeSupply.recoverPlanned('owned-contract-recovered');
    }
    try { shadow?.tick(epoch); } catch {
      if (nativeSupply.active) nativeSupply.fail('shadow-observation-failed');
      shadow?.stop(); shadow = null;
    }
    inspectModels();
    if (!publisher.busy && now() - lastSources >= 1000) { lastSources = now(); publisher.update(rows, now()); }
    publisher.pump(now());
    if (clock) emit({ type: 'snapshot', clock, counts: { translated, original }, collectionComplete: false,
      userFilterSummary: { ...userFilters.summary(), observation: userFilterObservation },
      displayPlanPlayback: { ...displayPlanObservation },
      nativeSupply: { report: nativeSupply.summary(), ...(owned ? { ownedRelease: owned.report() } : {}) } });
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
      const changed = generation !== d.generation;
      generation = d.generation; lastLease = now(); receivedControl = true;
      enabled = d.enabled === true; displayMode = d.displayMode === 'original' ? 'original' : 'translated';
      if (d.officialObservation && !officialObservation && !enabled && !nativeSupply.active &&
          typeof d.officialObservation.runId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(d.officialObservation.runId) &&
          ['native-1', 'native-3', 'native-5', 'dom'].includes(d.officialObservation.mode)) {
        shadow?.stop(); shadow = null; owned?.stop(); owned = null; userFilters.setEnabled(false);
        // Task-owned diagnostic pages never resume ordinary translation. Remove even
        // the disabled adapter's transparent wrappers before observing the official engine.
        const restored = [initRestore?.restore() ?? false, insertRestore?.restore() ?? false,
          validateRestore?.restore() ?? true, fetchRestore?.restore() ?? true];
        officialOwnsPage = true;
        officialObservation = new BilibiliOfficialObservation(binding, d.officialObservation.runId,
          d.officialObservation.mode as OfficialMode, () => epoch, epochNow);
        if (restored.every(Boolean)) emit({ type: 'bilibili-official-observation', report: officialObservation.start() });
        else emit({ type: 'bilibili-official-observation', report: { ready: false, error: 'adapter-hooks-not-restored' } });
      }
      if (d.officialObservationStop === true) {
        officialObservation?.stop();
        if (officialObservation) emit({ type: 'bilibili-official-observation', report: officialObservation.snapshot() });
      } else if (d.officialObservationExport === true && officialObservation)
        emit({ type: 'bilibili-official-observation', report: officialObservation.snapshot() });
      if (officialOwnsPage) enabled = false;
      const supplyRequested = d.nativeSupply?.enabled === true;
      const ownedRequested = d.bilibiliOwnedRelease === true;
      const plannedSelected = d.plannedSupply != null || nativeSupply.planned && !supplyRequested ||
        ownedRequested && !supplyRequested && !nativeSupply.active && enabled && displayMode === 'translated';
      if (!plannedSelected && d.nativeSupply === undefined && nativeSupply.active)
        nativeSupply.fail('native-supply-control-missing');
      const supplyConfiguration = plannedSelected
        ? ownedRequested && enabled && displayMode === 'translated' && !officialOwnsPage
          ? nativeSupply.configurePlanned(d.plannedSupply) : nativeSupply.configure(null)
        : d.nativeSupply === undefined && nativeSupply.active
          ? { activated: false, changed: false } : nativeSupply.configure(ownedRequested && !supplyRequested
            ? { enabled: true, policy: 'owned' } : d.nativeSupply);
      const activeOwned = ownedRequested && (nativeSupply.planned || supplyRequested) && nativeSupply.policy === 'owned' &&
        !officialOwnsPage && enabled && displayMode === 'translated';
      if (!plannedSelected && (ownedRequested !== (nativeSupply.active && nativeSupply.policy === 'owned') ||
          ownedRequested && !activeOwned)) nativeSupply.fail('owned-control-incompatible');
      if (plannedSelected && ownedRequested && enabled && displayMode === 'translated' && supplyRequested)
        nativeSupply.fail('planned-control-incompatible');
      if (activeOwned && !fetchRestore) nativeSupply.fail('owned-fetch-unavailable');
      if (activeOwned && !ownedHooksCurrent()) nativeSupply.fail('owned-hook-ownership-lost');
      if (activeOwned && !owned) {
        owned = new BilibiliOwnedRelease({ binding, session, now, epochNow, rules: options.shadowRules,
          onMiss: (id, sourceId, originalText, stimeMs, reason) =>
            nativeSupply.closeOwnedMiss(id, sourceId, originalText, epoch, stimeMs, reason),
          onUpdate: update => {
            nativeSupply.updatePrediction(update);
            if (!update.known && owned && !['warming-up', 'playback-inactive'].includes(owned.report().reason))
              nativeSupply.fail(`owned-${owned.report().reason}`);
            emit({ type: 'bilibili-shadow', sourceGeneration, ...update, revision: ++shadowUpdateRevision });
          } });
      } else if (!activeOwned && owned) { owned.stop(); owned = null; }
      if (supplyConfiguration.changed) owned?.reset('control-changed');
      if (nativeSupply.planned && nativeSupply.fault === 'control-lease-expired' && activeOwned &&
          ownedHooksCurrent() && d.plannedSupply?.enabled === true)
        nativeSupply.recoverPlanned('control-lease-renewed');
      if (supplyRequested && !nativeSupply.planned) {
        if (!enabled || displayMode !== 'translated') nativeSupply.fail('translation-control-incompatible');
        if (supplyConfiguration.activated) {
          const clear = read(binding.danmaku, 'clear');
          if (typeof clear !== 'function') nativeSupply.fail('native-clear-unavailable');
          else try { clear.call(binding.danmaku); } catch { nativeSupply.fail('native-clear-failed'); }
        }
      }
      userFilters.setEnabled(!officialOwnsPage && d.bilibiliUserFilters === true);
      // Observation-only mode can retain per-item unknowns without enabling
      // translation, suppression, or a native-supply permit.
      shadowReference = d.shadowReference === true && !enabled && !nativeSupply.active;
      if (!officialOwnsPage && !ownedRequested && d.bilibiliShadowScheduler === true && !shadow) {
        shadow = new BilibiliShadowSession({ binding, session, now, observeInit: false, rules: options.shadowRules,
          allowPartialUserRules: () => nativeSupply.active || shadowReference,
          onUpdate: update => {
            nativeSupply.updatePrediction(update);
            emit({ type: 'bilibili-shadow', sourceGeneration, ...update, revision: ++shadowUpdateRevision });
          } });
      } else if ((d.bilibiliShadowScheduler !== true || ownedRequested) && shadow) { shadow.stop(); shadow = null; }
      if (supplyRequested && !ownedRequested && d.bilibiliShadowScheduler !== true) nativeSupply.fail('shadow-scheduler-disabled');
      if (d.shadowExport === true && shadow) emit({ type: 'bilibili-shadow-report', report: shadow.report() });
      if (d.shadowExport === true && owned) emit({ type: 'bilibili-shadow-report', report: owned.report() });
      if (d.nativeSupplyExport === true) emit({ type: 'bilibili-native-supply-report', report: nativeSupply.report() });
      if (d.nativeSupplyExport === true && owned) emit({ type: 'bilibili-owned-release-report', report: owned.report() });
      if (d.userFilterRefresh === true) userFilters.invalidate();
      if (!nativeSupply.planned && (d.displayPlanPlayback === 'start' || d.displayPlanPlayback === 'prepare-live') && !displayPlanPlayback && !userFilterPlayback && !enabled) {
        const livePreview = d.displayPlanPlayback === 'prepare-live' && d.displayPlanOwner === 'live-preview' &&
          Number.isInteger(d.livePreviewFromMs) && d.livePreviewFromMs >= 0 && d.livePreviewFromMs <= 85000;
        if (d.displayPlanPlayback === 'prepare-live' && !livePreview) return;
        displayPlanPlayback = { time: binding.video.currentTime, paused: binding.video.paused === true,
          ...(livePreview ? { rate: binding.video.playbackRate } : {}) };
        displayPlanObservation.started = true; displayPlanObservation.restored = false; displayPlanObservation.seekCount = 0;
        if (d.displayPlanOwner === 'render-preview' || livePreview) {
          displayPlanObservation.owner = livePreview ? 'live-preview' : 'render-preview'; displayPlanObservation.restoreDisposition = 'pending';
          const target = typeof binding.video.closest === 'function' ? binding.video.closest('#playerWrap, .player-wrap') : binding.video;
          const changed = (event: Event) => { if (event.isTrusted && displayPlanPlayback) displayPlanPlayback.externalChange = true; };
          if (typeof target?.addEventListener === 'function') {
            target.addEventListener('pointerdown', changed, true); target.addEventListener('keydown', changed, true);
            displayPlanObservation.playbackListeners = 2;
            removeRenderPlaybackListeners = () => {
              target.removeEventListener('pointerdown', changed, true); target.removeEventListener('keydown', changed, true);
              displayPlanObservation.playbackListeners = 0;
            };
          }
        }
        try {
          if (livePreview) { binding.video.pause(); binding.video.playbackRate = 1; binding.video.currentTime = d.livePreviewFromMs / 1000; }
          else Promise.resolve(binding.video.play()).catch(() => {});
        } catch { /* Playback is confirmed through the media clock. */ }
      } else if (!nativeSupply.planned && d.displayPlanPlayback === 'pause' && displayPlanPlayback && !enabled) {
        try { binding.video.pause(); } catch { /* Confirmation comes from the next clock snapshot. */ }
      } else if (!nativeSupply.planned && d.displayPlanPlayback === 'play' && displayPlanPlayback && !enabled) {
        try { Promise.resolve(binding.video.play()).catch(() => {}); } catch { /* Confirmation comes from the next clock snapshot. */ }
      } else if (!nativeSupply.planned && d.displayPlanPlayback === 'seek' && displayPlanPlayback && !enabled) {
        const duration = Number(binding.video.duration), current = Number(binding.video.currentTime);
        if (Number.isFinite(duration) && Number.isFinite(current) && duration > 15) {
          binding.video.currentTime = Math.max(0, Math.min(duration - 6, current + 12));
          displayPlanObservation.seekCount++;
          try { Promise.resolve(binding.video.play()).catch(() => {}); } catch { /* Recorded by playback clock. */ }
        }
      } else if (!nativeSupply.planned && d.displayPlanPlayback === 'restore' && displayPlanPlayback) {
        restoreDisplayPlanPlayback();
      }
      if (!nativeSupply.planned && d.userFilterObserve === 'start' && !userFilterPlayback) {
        userFilters.setAudit(true);
        userFilterPlayback = { time: binding.video.currentTime, paused: binding.video.paused === true };
        const hit = userFilters.firstExcludedTime();
        userFilterObservation = { started: true, playing: false, restored: false, selectedRuleHit: hit !== null };
        if (hit !== null) binding.video.currentTime = Math.max(0, hit / 1000 - 1);
        try { Promise.resolve(binding.video.play()).then(() => {
          userFilterObservation.playing = binding.video.paused === false;
        }).catch(() => {}); } catch { /* Autoplay policy is a recorded observation gap. */ }
      } else if (!nativeSupply.planned && d.userFilterObserve === 'restore' && userFilterPlayback) {
        userFilters.setAudit(false);
        const previous = userFilterPlayback; userFilterPlayback = null;
        try {
          binding.video.pause(); binding.video.currentTime = previous.time;
          if (!previous.paused) Promise.resolve(binding.video.play()).then(() => {
            userFilterObservation.restored = binding.video.paused === false;
          }).catch(() => {});
          else userFilterObservation.restored = binding.video.paused === true;
        } catch { userFilterObservation.restored = false; }
      }
      if (d.clear === true) {
        prepared.clear(); decisions.clear(); translated = 0; original = 0;
        nativeSupply.invalidate('control-clear');
      }
      if (d.resync === true) { sourceGeneration = d.generation; publisher.reset(); lastSources = -Infinity; }
      if (changed || d.clear === true || d.resync === true) { eligibility.reset(); userFilters.invalidate(); }
    } else if (d.type === 'sources-ack') {
      if (d.sourceGeneration === sourceGeneration && Number.isSafeInteger(d.revision) && Number.isSafeInteger(d.index)) publisher.acknowledge(d.revision, d.index, now());
    } else if (d.type === 'forget' && d.generation === generation && Array.isArray(d.ids)) {
      for (const id of d.ids.slice(0, 500)) if (typeof id === 'string') { prepared.delete(id); decisions.delete(id); }
      nativeSupply.forget(d.ids.slice(0, 500).filter((id: unknown): id is string => typeof id === 'string'));
    } else if (d.type === 'prepared' && d.generation === generation && enabled && Array.isArray(d.items)) {
      if (nativeSupply.active) {
        if (nativeSupply.planned ? d.plannedSupply !== true : d.nativeSupply !== true) return;
        for (const item of d.items.slice(0, 200)) {
          const source = item && typeof item.id === 'string' ? sourceRows.get(item.id) : undefined;
          nativeSupply.acceptPrepared(item, source, epoch);
        }
        return;
      }
      if (d.nativeSupply === true || d.plannedSupply === true) return;
      for (const item of d.items.slice(0, 200)) {
        if (!item || typeof item.id !== 'string' || item.id.length > 400 || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 2000 ||
            typeof item.originalText !== 'string' || item.originalText.length > MAX_TEXT_LENGTH) continue;
        const source = sourceRows.get(item.id);
        if (!source || source.originalText !== item.originalText) continue;
        if (userFilters.decision(source).state === 'exclude') continue;
        prepared.set(item.id, { text: item.text, originalText: item.originalText });
        if (!everPlayed) decisions.delete(item.id);
      }
    }
  }

  const onSeeking = () => nextEpoch();
  const onPlaying = () => { everPlayed = true; if (nativeSupply.planned) tick(); };
  const onPlaybackHold = () => { if (nativeSupply.planned) tick(); };
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
  addEvent('pause', onPlaybackHold); addEvent('waiting', onPlaybackHold);

  function restoreDisplayPlanPlayback() {
    const previous = displayPlanPlayback;
    if (!previous) return;
    if (previous.externalChange) {
      displayPlanObservation.restoreDisposition = 'preserved-external-change';
      displayPlanObservation.restored = true; displayPlanObservation.started = false;
      displayPlanPlayback = null; removeRenderPlaybackListeners(); return;
    }
    const finish = () => {
      if (displayPlanPlayback !== previous) return;
      displayPlanObservation.restored = binding.video.paused === previous.paused &&
        Math.abs(binding.video.currentTime - previous.time) < 0.5;
      if (displayPlanObservation.restored) {
        displayPlanPlayback = null; displayPlanObservation.started = false; removeRenderPlaybackListeners();
        if (displayPlanObservation.owner === 'render-preview' || displayPlanObservation.owner === 'live-preview') displayPlanObservation.restoreDisposition = 'restored-baseline';
      }
    };
    try {
      binding.video.pause(); binding.video.currentTime = previous.time;
      if (previous.rate !== undefined) binding.video.playbackRate = previous.rate;
      if (previous.paused) finish();
      else Promise.resolve(binding.video.play()).then(finish).catch(() => {});
    } catch { displayPlanObservation.restored = false; }
  }
  const stop = () => {
    if (stopped) return { hookRestored: false, insertRestored: false, initRestored: false, laterWrapperPreserved: true };
    restoreDisplayPlanPlayback();
    officialObservation?.stop();
    removeRenderPlaybackListeners();
    stopped = true; enabled = false; shadow?.stop(); shadow = null; owned?.stop(); owned = null;
    userFilters.stop(); for (const dispose of disposes.splice(0)) dispose();
    for (const record of observedModels.values()) record.restore?.restore();
    observedModels.clear();
    removePlayerMarker(marker, session);
    const hookRestored = read(read(binding.danmaku, 'hooks'), 'beforeRender') === originalHook;
    const initRestored = initRestore.restore();
    const insertRestored = insertRestore.restore();
    const validateRestored = validateRestore?.restore() ?? true;
    const fetchRestored = fetchRestore?.restore() ?? true;
    return { hookRestored, insertRestored, initRestored,
      laterWrapperPreserved: !hookRestored || !insertRestored || !initRestored || !validateRestored || !fetchRestored };
  };

  return { session, identity: binding.identity, binding, publisher, prepared, decisions, nativeSupply,
    get epoch() { return epoch; }, tick, onMessage, stop };
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
