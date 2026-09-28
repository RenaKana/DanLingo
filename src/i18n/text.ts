import { catalogs } from './catalogs.ts';
import performanceMessages from './performance-messages.json' with { type: 'json' };
import type { UiLocale } from './locale.ts';
import { messageFromSource, type UiMessage, type MessageParams } from './wire.ts';
export { messageFromSource, type UiMessage, type MessageParams } from './wire.ts';
// Pure renderers retain the source locale until a UI context resolves its browser preference.
let activeLocale: UiLocale = 'zh-CN';
const subscribers = new Set<() => void>();
export const getLocale = (): UiLocale => activeLocale;
export function setLocale(locale: UiLocale): void {
  if (locale === activeLocale) return;
  activeLocale = locale;
  for (const listener of [...subscribers]) listener();
}
export function onLocaleChange(listener: () => void): () => void {
  subscribers.add(listener); return () => { subscribers.delete(listener); };
}
export function formatNumber(value: number): string { return new Intl.NumberFormat(activeLocale).format(value); }
export function formatDate(value: number | Date): string { return new Intl.DateTimeFormat(activeLocale, { dateStyle: 'medium', timeStyle: 'short' }).format(value); }
export function tCount(key: string, count: number, params: MessageParams = {}): string {
  const category = new Intl.PluralRules(activeLocale).select(count);
  const variant = key + '.' + category;
  return t(Object.hasOwn(catalogs[activeLocale], variant) ? variant : key + '.other', { ...params, count });
}
export function t(key: string, params: MessageParams = {}): string {
  // Test-build performance wording is translated with the catalogs at formal release time.
  const template = catalogs[activeLocale]?.[key] ?? catalogs.en[key] ?? catalogs['zh-CN'][key] ?? (performanceMessages as Record<string, string>)[key] ?? key;
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : typeof value === 'number' ? formatNumber(value) : value;
  });
}
export function message(id: string, params?: MessageParams): UiMessage { return params ? { id, params } : { id }; }
export class UiError extends Error {
  readonly uiMessage: UiMessage;
  constructor(id: string, params?: MessageParams) { super(id); this.name = 'UiError'; this.uiMessage = message(id, params); }
}

function safeErrorParams(params: MessageParams = {}): MessageParams {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, typeof value !== 'string' ? value : value
    .replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{30,})\b/g, '[redacted]')
    .replace(/(https?:\/\/)[^\s/:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\b(Bearer|api[-_ ]?key|token|password)(?:\s*[:=]\s*|\s+)[A-Za-z0-9_.-]{12,}/gi, '$1 [redacted]')]));
}

export function localizeMessage(value: unknown): string {
  if (value instanceof UiError) return localizeMessage(value.uiMessage);
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' && Object.hasOwn(catalogs.en, value.id)) {
    const raw = (value as UiMessage).params;
    const params = raw && typeof raw === 'object' ? Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string' || typeof v === 'number')) : {};
    return t(value.id, safeErrorParams(params));
  }
  const source = messageFromSource(value instanceof Error ? value.message : value);
  if (source) return t(source.id, safeErrorParams(source.params));
  if (value === '' || value == null) return '';
  return t('error.unknown');
}
