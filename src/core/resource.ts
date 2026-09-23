import type { PlatformResource, ResourceSession } from './types.ts';
import { watchIdFromUrl } from './messages.ts';

/** URL candidates; an adapter must additionally verify actual live playback, not replay. */
export function resourceFromUrl(value: string): PlatformResource | null {
  const video = watchIdFromUrl(value);
  if (video) return { platform: 'niconico', scenario: 'video', resourceId: video };
  try {
    const url = new URL(value);
    if (url.origin === 'https://www.bilibili.com') {
      const id = /^\/video\/(BV[0-9A-Za-z]{10}|av[1-9]\d*)\/?$/.exec(url.pathname)?.[1];
      const page = url.searchParams.get('p') ?? '1';
      if (id && /^[1-9]\d{0,4}$/.test(page)) return { platform: 'bilibili', scenario: 'video', resourceId: `${id}:p${page}` };
    }
    if (url.origin === 'https://live.bilibili.com') {
      if (url.username || url.password) return null;
      const id = /^\/(?:blanc\/)?([1-9]\d{0,19})\/?$/.exec(url.pathname)?.[1];
      if (id) return { platform: 'bilibili', scenario: 'live', resourceId: id };
    }
    if (url.origin === 'https://www.youtube.com') {
      const id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/live\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
      if (id && /^[\w-]{11}$/.test(id)) return { platform: 'youtube', scenario: 'live', resourceId: id };
    }
    if (url.origin === 'https://live.nicovideo.jp') {
      const id = /^\/watch\/(lv\d+)\/?$/.exec(url.pathname)?.[1];
      if (id) return { platform: 'niconico', scenario: 'live', resourceId: id };
    }
  } catch { /* Untrusted URL. */ }
  return null;
}
export function sameResource(a: PlatformResource | null | undefined, b: PlatformResource | null | undefined): boolean {
  return !!a && !!b && a.platform === b.platform && a.scenario === b.scenario && a.resourceId === b.resourceId;
}
export function sameSession(a: ResourceSession | null | undefined, b: ResourceSession | null | undefined): boolean {
  return sameResource(a, b) && a!.urlResourceId === b!.urlResourceId && a!.sessionId === b!.sessionId && a!.generation === b!.generation;
}
/** An URL is only a candidate; Bilibili must additionally bind its native content identity. */
export function matchesResourceUrl(resource: PlatformResource | null | undefined, value: string): boolean {
  const candidate = resourceFromUrl(value);
  if (!resource || !candidate || resource.platform !== candidate.platform || resource.scenario !== candidate.scenario) return false;
  return resource.platform === 'bilibili'
    ? validBilibiliResource(resource) && resource.urlResourceId === candidate.resourceId
    : sameResource(resource, candidate);
}
export function resourceOrigin(resource: Pick<PlatformResource, 'platform' | 'scenario'>): string {
  if (resource.platform === 'bilibili') return resource.scenario === 'live' ? 'https://live.bilibili.com' : 'https://www.bilibili.com';
  return resource.platform === 'youtube' ? 'https://www.youtube.com'
    : resource.scenario === 'live' ? 'https://live.nicovideo.jp' : 'https://www.nicovideo.jp';
}
export function validBilibiliResource(resource: PlatformResource): boolean {
  return resource.platform === 'bilibili' && typeof resource.urlResourceId === 'string' && (resource.scenario === 'video'
    ? /^av[1-9]\d{0,19}:cid[1-9]\d{0,19}$/.test(resource.resourceId) && /^(BV[0-9A-Za-z]{10}|av[1-9]\d{0,19}):p[1-9]\d{0,4}$/.test(resource.urlResourceId)
    : resource.scenario === 'live' && /^room:[1-9]\d{0,19}$/.test(resource.resourceId) && /^[1-9]\d{0,19}$/.test(resource.urlResourceId));
}
export function validSession(value: unknown): value is ResourceSession {
  if (!value || typeof value !== 'object') return false;
  const s = value as ResourceSession;
  return ['niconico', 'youtube', 'bilibili'].includes(s.platform) && ['video', 'live'].includes(s.scenario) &&
    (s.platform !== 'bilibili' ? s.urlResourceId === undefined : validBilibiliResource(s)) &&
    typeof s.resourceId === 'string' && s.resourceId.length > 0 && s.resourceId.length <= 100 &&
    typeof s.sessionId === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(s.sessionId) && Number.isSafeInteger(s.generation) && s.generation >= 0;
}
export function cacheResource(resource: PlatformResource): string {
  // Keep all pre-0.2 Niconico video cache entries usable, without a global clear.
  return resource.platform === 'niconico' && resource.scenario === 'video' ? resource.resourceId
    : JSON.stringify([resource.platform, resource.scenario, resource.resourceId]);
}
export function liveEventId(resource: PlatformResource, sourceId: string): string {
  return JSON.stringify([resource.platform, resource.scenario, resource.resourceId, sourceId]);
}
/** Convert a transported remaining budget once; async storage/network never renew it. */
export function localDeadline(remainingMs: number, sentAt: number, receivedAt: number, now: number, capMs = 3000): number {
  if (![remainingMs, sentAt, receivedAt, now].every(Number.isFinite) || remainingMs <= 0 || sentAt > receivedAt + 1000) return now;
  return now + Math.max(0, Math.min(capMs, remainingMs) - Math.max(0, receivedAt - sentAt));
}
export function clockStamp(): number { return performance.timeOrigin + performance.now(); }
