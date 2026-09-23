import { inlineEmotes, prepareEmoteText, type InlineEmotes } from './emotes.ts';
type Data = Record<string, any>;
export interface BilibiliComment {
  sourceId: string; originalText: string; translatable: boolean; packet: Data;
  nativeId?: string; timestamp?: number;
  inlineEmotes?: InlineEmotes;
}
export function decimalId(value: unknown): string | null {
  if (typeof value === 'string' && /^[1-9]\d{0,29}$/.test(value)) return value;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}
/** Ordinary chat IDs are opaque (including the site's 35-character hex IDs).
 * Never coerce numbers: precision, leading zeroes and case are part of identity. */
export function ordinaryMessageId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}
/** Registered inline emotes may accompany prose; standalone pictures/effects stay native. */
export function ordinaryComment(packet: unknown, fallbackId: string): BilibiliComment | null {
  const p = packet as Data, info = p?.info, style = info?.[0];
  if (!p || typeof p.cmd !== 'string' || !/^DANMU_MSG(?::[\d:]+)?$/.test(p.cmd) || !Array.isArray(info) || !Array.isArray(style) ||
      ![1,4,5,6].includes(style[1]) || typeof info[1] !== 'string' || !info[1] || info[1].length > 1000) return null;
  let extra: Data = {};
  const rawExtra = style[15]?.extra;
  if (rawExtra !== undefined && (typeof rawExtra !== 'string' || rawExtra.length > 16000)) return null;
  try { if (rawExtra !== undefined) extra = JSON.parse(rawExtra); } catch { return null; }
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return null;
  const animation = extra.animation;
  const hasAnimation = Array.isArray(animation) ? true :
    animation !== null && typeof animation === 'object' ? Object.keys(animation).length > 0 : !!animation;
  const emotes = inlineEmotes(extra.emots);
  const tokens = emotes && Object.keys(emotes).filter(token => info[1].includes(token));
  const mixed = tokens && tokens.length > 0 ? prepareEmoteText(info[1], tokens) : null;
  const special = !!(style[12] || style[13]?.emoticon_unique || !emotes || mixed && !mixed.hasProse || extra.emoticon_unique || style[15]?.mode || extra.mode || hasAnimation || extra.dm_type);
  const nativeId = ordinaryMessageId(extra.id_str);
  return { sourceId: nativeId ? `dm:${nativeId}` : fallbackId, originalText: info[1], translatable: !special,
    packet: p, ...(tokens?.length ? { inlineEmotes: Object.fromEntries(tokens.map(token => [token, emotes![token]!])) } : {}),
    ...(nativeId ? { nativeId } : {}), ...(Number.isFinite(style[4]) ? { timestamp: style[4] } : {}) };
}
export function translatedPacket(source: BilibiliComment, text: string): Data {
  // Preserve all non-body fields, including routing suffixes, metadata and emotes.
  const info = source.packet.info.slice(); info[1] = text;
  return { ...source.packet, info };
}
export interface SuperChatSource { sourceId: string; nativeId: string; originalText: string; expiresAt: number }
export function superChatSource(packet: unknown, nowEpochMs: number): SuperChatSource | null {
  const p = packet as Data, data = p?.data;
  if (p?.cmd !== 'SUPER_CHAT_MESSAGE' || !data || typeof data.message !== 'string' || !data.message.trim() || data.message.length > 1000) return null;
  const id = decimalId(data.id);
  const end = typeof data.end_time === 'number' && Number.isFinite(data.end_time) ? data.end_time * 1000 : NaN;
  // No invented lifetime: an unknown or already expired card is not eligible for automatic repair.
  if (!id || !Number.isFinite(end) || end <= nowEpochMs || end > nowEpochMs + 86400000) return null;
  return { sourceId: `sc:${id}`, nativeId: id, originalText: data.message, expiresAt: end };
}
export function deletedSuperChats(packet: unknown): string[] {
  const p = packet as Data;
  if (p?.cmd !== 'SUPER_CHAT_MESSAGE_DELETE' || !Array.isArray(p.data?.ids)) return [];
  return (p.data.ids as unknown[]).slice(0, 500).map(decimalId).filter((id): id is string => id !== null).map(id => `sc:${id}`);
}
