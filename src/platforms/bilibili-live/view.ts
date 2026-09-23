import { resourceFromUrl } from '../../core/resource.ts';
import { visible } from './repairs-dom.ts';

export interface BilibiliLiveView {
  window: Window & typeof globalThis;
  document: Document;
  frame?: HTMLIFrameElement;
  urlResourceId: string;
  playerRoomId: string;
}

/** Room URL aliases share one candidate; presentation parameters do not identify a room. */
export function activityPlayerRoom(value: string): string | null {
  const resource = resourceFromUrl(value);
  return resource?.platform === 'bilibili' && resource.scenario === 'live' ? resource.resourceId : null;
}

export function bilibiliLiveView(page: Window & typeof globalThis): BilibiliLiveView | null {
  try {
    const resource = resourceFromUrl(page.location.href);
    if (page.top !== page || resource?.platform !== 'bilibili' || resource.scenario !== 'live') return null;
    const document = page.document;
    if (document.querySelector('#live-player')) return { window: page, document, urlResourceId: resource.resourceId, playerRoomId: resource.resourceId };
    // Do not select hidden/preloaded players, arbitrary frames or ambiguous multi-player pages.
    const frames = [...document.querySelectorAll<HTMLIFrameElement>('iframe')]
      .filter(frame => activityPlayerRoom(frame.src) && visible(frame));
    if (frames.length !== 1) return null;
    const frame = frames[0]!, roomId = activityPlayerRoom(frame.src)!;
    const child = frame.contentWindow as (Window & typeof globalThis) | null;
    if (!child || child.parent !== page || activityPlayerRoom(child.location.href) !== roomId || child.document !== frame.contentDocument) return null;
    return { window: child, document: child.document, frame, urlResourceId: resource.resourceId, playerRoomId: roomId };
  } catch { return null; }
}

export function sameBilibiliView(a: BilibiliLiveView | null, b: BilibiliLiveView | null): boolean {
  return !!a && !!b && a.document === b.document && a.frame === b.frame && a.urlResourceId === b.urlResourceId && a.playerRoomId === b.playerRoomId;
}
