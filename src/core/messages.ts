import type { SourceMessage } from './types.ts';

export const MAX_SOURCE_MESSAGES = 20000;
export const MAX_TEXT_LENGTH = 1000;

export function watchIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://www.nicovideo.jp') return null;
    return /^\/watch\/((?:sm|so|nm)\d+|\d{10})\/?$/.exec(url.pathname)?.[1] ?? null;
  } catch { return null; }
}

export function sourceEventId(resourceId: string, threadId: string, fork: string, sourceId: string): string {
  return JSON.stringify([resourceId, threadId, fork, sourceId]);
}
export function bilibiliSourceEventId(resourceId: string, sourceId: string): string {
  return JSON.stringify(['bilibili', resourceId, sourceId]);
}

/** The web bridge is untrusted; only bounded fields used by the extension survive. */
export function parseSources(value: unknown, resourceId: string, platform: SourceMessage['platform'] = 'niconico'): SourceMessage[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: SourceMessage[] = [];
  for (const input of value.slice(0, MAX_SOURCE_MESSAGES)) {
    if (!input || typeof input !== 'object') continue;
    const m = input as Record<string, unknown>;
    if (platform === 'bilibili' && (m.platform !== 'bilibili' || m.fork !== 'main' ||
        !/^\d+$/.test(String(m.sourceId)) || m.threadId !== /^av\d+:cid(\d+)$/.exec(resourceId)?.[1])) continue;
    if (typeof m.sourceId !== 'string' || !m.sourceId || m.sourceId.length > 100 ||
        typeof m.threadId !== 'string' || m.threadId.length > 100 ||
        !['main', 'easy', 'owner'].includes(String(m.fork)) ||
        typeof m.originalText !== 'string' || !m.originalText || m.originalText.length > MAX_TEXT_LENGTH ||
        typeof m.mediaTimeMs !== 'number' || !Number.isFinite(m.mediaTimeMs) || m.mediaTimeMs < 0 ||
        typeof m.renderAtMs !== 'number' || !Number.isFinite(m.renderAtMs) || m.renderAtMs < -10000 ||
        m.renderAtMs > m.mediaTimeMs || m.mediaTimeMs > 24 * 3600 * 1000) continue;
    const id = platform === 'bilibili' ? bilibiliSourceEventId(resourceId, m.sourceId) : sourceEventId(resourceId, m.threadId, String(m.fork), m.sourceId);
    if (seen.has(id)) continue;
    seen.add(id);
    const s = m.style && typeof m.style === 'object' ? m.style as Record<string, unknown> : {};
    const style = {
      position: typeof s.position === 'string' ? s.position.slice(0, 20) : '',
      size: typeof s.size === 'string' ? s.size.slice(0, 20) : '',
      color: typeof s.color === 'string' ? s.color.slice(0, 30) : '',
      font: typeof s.font === 'string' ? s.font.slice(0, 100) : '',
      commands: Array.isArray(s.commands) ? s.commands.filter((x): x is string => typeof x === 'string' && x.length <= 100).slice(0, 30) : [],
    };
    const message: SourceMessage = {
      id, sourceId: m.sourceId, platform, resourceId, threadId: m.threadId, fork: String(m.fork),
      originalText: m.originalText, mediaTimeMs: m.mediaTimeMs, renderAtMs: m.renderAtMs,
      translatable: m.translatable === true && m.fork !== 'owner' && (platform !== 'bilibili' || ['1','4','5','6'].includes(style.position)), style,
    };
    if (typeof m.sentAtEpochMs === 'number' && Number.isFinite(m.sentAtEpochMs) && m.sentAtEpochMs > 0) message.sentAtEpochMs = m.sentAtEpochMs;
    result.push(message);
  }
  return result.sort((a, b) => a.renderAtMs - b.renderAtMs);
}

export function needsTranslation(text: string, targetLanguage: string, sourceLanguage = 'auto'): boolean {
  // Conservative bypass only. No trim/lowercase/repetition normalization of cache text.
  if (!/[\p{L}]/u.test(text)) return false;
  if (/^[wｗWＷ草笑\p{P}\p{S}\s]+$/u.test(text)) return false;
  if (sourceLanguage !== 'auto' && sourceLanguage.split('-')[0] !== targetLanguage.split('-')[0]) return true;
  if (targetLanguage.startsWith('zh')) {
    if (/[\u3040-\u30ff\uFF66-\uFF9D]/u.test(text)) return true;
    if (/\p{Script=Hangul}|[A-Za-z]/u.test(text)) return true;
    // Pure Han short text is ambiguous (e.g. Japanese names); retain it.
    return false;
  }
  return true;
}
