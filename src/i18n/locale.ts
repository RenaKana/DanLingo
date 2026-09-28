export const LOCALES = [
  { code: 'zh-CN', name: '简体中文', dir: 'ltr' }, { code: 'zh-TW', name: '繁體中文', dir: 'ltr' },
  { code: 'en', name: 'English', dir: 'ltr' }, { code: 'ja', name: '日本語', dir: 'ltr' },
  { code: 'ko', name: '한국어', dir: 'ltr' }, { code: 'es', name: 'Español', dir: 'ltr' },
  { code: 'fr', name: 'Français', dir: 'ltr' }, { code: 'de', name: 'Deutsch', dir: 'ltr' },
  { code: 'pt-BR', name: 'Português (Brasil)', dir: 'ltr' }, { code: 'ru', name: 'Русский', dir: 'ltr' },
  { code: 'it', name: 'Italiano', dir: 'ltr' }, { code: 'tr', name: 'Türkçe', dir: 'ltr' },
  { code: 'ar', name: 'العربية', dir: 'rtl' }, { code: 'hi', name: 'हिन्दी', dir: 'ltr' },
  { code: 'id', name: 'Bahasa Indonesia', dir: 'ltr' }, { code: 'vi', name: 'Tiếng Việt', dir: 'ltr' },
  { code: 'th', name: 'ไทย', dir: 'ltr' }, { code: 'nl', name: 'Nederlands', dir: 'ltr' },
  { code: 'pl', name: 'Polski', dir: 'ltr' }, { code: 'uk', name: 'Українська', dir: 'ltr' },
] as const;
export type UiLocale = typeof LOCALES[number]['code'];
export type LocalePreference = 'auto' | UiLocale;
export const UI_LOCALE_KEY = 'ui.locale.v1';
export function localePreference(value: unknown): LocalePreference {
  return value === 'auto' || LOCALES.some(item => item.code === value) ? value as LocalePreference : 'auto';
}
export function matchLocale(language: string): UiLocale | undefined {
  const normalized = language.replaceAll('_', '-').toLowerCase();
  if (normalized === 'zh' || normalized.startsWith('zh-')) {
    return /(?:^|-)(?:hant|tw|hk|mo)(?:-|$)/.test(normalized) ? 'zh-TW' : 'zh-CN';
  }
  if (normalized === 'pt' || normalized.startsWith('pt-')) return 'pt-BR';
  return LOCALES.find(item => item.code.toLowerCase() === normalized || item.code === normalized.split('-')[0])?.code;
}
export function resolveLocale(preference: LocalePreference, browserLanguage: string): UiLocale {
  return preference === 'auto' ? matchLocale(browserLanguage) ?? 'en' : preference;
}
