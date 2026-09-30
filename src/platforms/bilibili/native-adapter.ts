/** Verified native-engine access. Translation and scheduling stay in video/owned-release. */
import { bilibiliSourceEventId, MAX_TEXT_LENGTH } from '../../core/messages.ts';
import { parseBilibiliVideoUrl, type BilibiliUrlIdentity } from '../../core/bilibili-video-url.ts';
import type { SourceMessage } from '../../core/types.ts';
import { findReviewedDanmakuBuild } from './native-builds.ts';
export const ORDINARY_MODES = new Set([1, 4, 5, 6]);
type Native = Record<string, any>;

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


export function objectLike(value: unknown): value is Native {
  return !!value && typeof value === 'object';
}

export function read(value: unknown, key: string): unknown {
  if (!objectLike(value)) return undefined;
  try { return value[key]; } catch { return undefined; }
}

export function ownDescriptor(value: unknown, key: string): PropertyDescriptor | undefined {
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

export function nativeDmid(value: unknown): string | null {
  // A numeric dmid may already have lost precision.  Do not stringify it.
  return typeof value === 'string' && /^\d+$/.test(value) ? value : null;
}

export function dmidFromItem(item: unknown): string | null {
  if (!objectLike(item)) return null;
  return nativeDmid(read(item, 'dmid')) ?? nativeDmid(read(item, 'id_str'));
}

export function nativeMode(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10000 ? value : null;
}

/**
 * Public playback manifest, not URL metadata or private/account stores.
 * Verified with core.ba67b466.js and the current runtime on 2026-09-21.
 */
export function resolveIdentity(player: Native, url: BilibiliUrlIdentity): BilibiliNativeIdentity | null {
  try {
    const getter = read(player, 'getManifest');
    if (typeof getter !== 'function') return null;
    const candidate = getter.call(player);
    const aid = safeDecimal(read(candidate, 'aid'));
    const cid = safeDecimal(read(candidate, 'cid'));
    const bvidValue = read(candidate, 'bvid');
    const bvid = typeof bvidValue === 'string' && /^BV[0-9A-Za-z]{10}$/.test(bvidValue) ? bvidValue : null;
    const page = safePage(read(candidate, 'p'));
    if (!aid || !cid || aid === '0' || cid === '0' || !page) return null;
    if (url.playbackIdentity === 'manifest') {
      // Festival is a container: player.reload can change BV/CID/P while its
      // entry URL stays unchanged. Keep that URL scope, but bind actual media.
      if (!bvid) return null;
    } else {
      if (page !== url.page || url.bvid && bvid !== url.bvid || url.aid && aid !== url.aid) return null;
    }
    return {
      resourceId: `av${aid}:cid${cid}`,
      urlResourceId: url.urlResourceId,
      aid, cid, page,
      ...(bvid ? { bvid } : {}),
    };
  } catch { return null; }
}

export function videoLike(value: unknown): value is Native {
  return objectLike(value) && typeof read(value, 'currentTime') === 'number' &&
    typeof read(value, 'paused') === 'boolean' && typeof read(value, 'playbackRate') === 'number';
}

export function connected(value: Native): boolean {
  const state = read(value, 'isConnected');
  return state === undefined || state === true;
}

export function findVideo(player: Native): Native | null {
  const getter = read(player, 'mediaElement');
  if (typeof getter === 'function') {
    try { const value = getter.call(player); if (videoLike(value) && connected(value)) return value; } catch { /* fail closed */ }
  }
  return null;
}

const ENGINE_ADAPTERS = {
  'danmaku-x-v1': {
    matches(instance: Native): boolean {
      const hooks = read(instance, 'hooks');
      const manager = read(instance, 'manager');
      const descriptor = ownDescriptor(hooks, 'beforeRender');
      return objectLike(hooks) && !!descriptor && 'value' in descriptor &&
        typeof descriptor.value === 'function' && descriptor.writable === true &&
        objectLike(manager) && Array.isArray(read(manager, 'visualArray')) &&
        Array.isArray(read(read(manager, 'dataBase'), 'dmArray')) &&
        typeof read(manager, 'insert') === 'function' && typeof read(manager, 'initRender') === 'function';
    },
  },
} as const;

export function isSupportedDanmaku(instance: unknown): instance is Native {
  if (!objectLike(instance)) return false;
  try {
    const metadata = typeof instance.getMetadata === 'function' ? instance.getMetadata() : null;
    const build = findReviewedDanmakuBuild(metadata);
    return !!build && ENGINE_ADAPTERS[build.adapter].matches(instance);
  } catch { return false; }
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

export function validDanmakuText(item: unknown): item is Native {
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

export interface MethodRestore {
  wrapper: Function;
  isCurrent(): boolean;
  restore(): boolean;
}

export function installMethodWrapper(target: Native, key: string, makeWrapper: (original: Function) => Function): MethodRestore | null {
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

