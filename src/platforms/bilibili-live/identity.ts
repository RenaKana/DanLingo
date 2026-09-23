import { decimalId } from './messages.ts';

type Data = Record<string, any>;

/** SSR has roomInitRes; client-rendered /blanc/ rooms expose the initialized player instead. */
export function bilibiliRoomIdentity(host: Data, document: Document, candidate: string): { roomId: string; live: boolean } | null {
  try {
    const roomId = decimalId(host.BilibiliLive?.ROOMID);
    if (!roomId) return null;
    const init = host.__NEPTUNE_IS_MY_WAIFU__?.roomInitRes?.data;
    if (init) {
      if (roomId !== decimalId(init.room_id) || (candidate !== roomId && candidate !== decimalId(init.short_id))) return null;
      return { roomId, live: init.live_status === 1 || init.live_status === '1' };
    }
    if (candidate !== roomId && candidate !== decimalId(host.BilibiliLive?.SHORT_ROOMID)) return null;
    const player = host.EmbedPlayer?.instance;
    const video = player?.getVideoEl?.(), root = document.querySelector('#live-player');
    // The public player API must belong to this document's actual player. URL/global IDs alone are insufficient.
    if (!root || !video || video.ownerDocument !== document || video.tagName !== 'VIDEO' || !root.contains(video)) return null;
    const info = player.getPlayerInfo?.();
    if (!info || ![0, 1, 2].includes(info.liveStatus) || !Number.isFinite(info.timeShift)) return null;
    return { roomId, live: info.liveStatus === 1 && info.timeShift === 0 };
  } catch { return null; }
}
