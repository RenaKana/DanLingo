import { browser } from 'wxt/browser';
import { LOCALES, UI_LOCALE_KEY, localePreference, resolveLocale, type LocalePreference } from './locale.ts';
import { getLocale, onLocaleChange, setLocale, t } from './text.ts';
export * from './locale.ts';
export * from './text.ts';

/** Only explicitly marked extension-owned nodes are touched, never user content. */
export function localize(root: ParentNode): void {
  const selectors = ['data-i18n', 'data-i18n-title', 'data-i18n-placeholder', 'data-i18n-aria-label'];
  const nodes = [...root.querySelectorAll<HTMLElement>(selectors.map(name => '[' + name + ']').join(','))];
  if (root instanceof HTMLElement && selectors.some(name => root.hasAttribute(name))) nodes.unshift(root);
  for (const node of nodes) {
    const key = node.getAttribute('data-i18n');
    if (key) node.textContent = t(key);
    for (const attribute of ['title', 'placeholder', 'aria-label']) {
      const id = node.getAttribute('data-i18n-' + attribute);
      if (id) node.setAttribute(attribute, t(id));
    }
  }
}
type LocaleRoot = Document | HTMLElement | ShadowRoot;
const registrations = new WeakMap<LocaleRoot, Promise<() => void>>();
export function initLocale(root: LocaleRoot = document, select?: HTMLSelectElement): Promise<() => void> {
  const existing = registrations.get(root); if (existing) return existing;
  const promise = startLocale(root, select); registrations.set(root, promise); return promise;
}
async function startLocale(root: LocaleRoot, select?: HTMLSelectElement): Promise<() => void> {
  let disposed = false, revision = 0;
  let preference: LocalePreference = 'auto';
  const browserLanguage = browser.i18n?.getUILanguage?.() || (typeof navigator !== 'undefined' ? navigator.language : 'en');
  const target = root instanceof Document ? root.documentElement : root instanceof ShadowRoot ? root.host as HTMLElement : root;
  const apply = () => {
    if (disposed) return;
    target.lang = getLocale(); target.dir = getLocale() === 'ar' ? 'rtl' : 'ltr';
    localize(root);
    if (select) {
      const auto = select.querySelector<HTMLOptionElement>('option[value="auto"]'); if (auto) auto.textContent = t('locale.auto');
      select.setAttribute('aria-label', t('locale.label'));
      select.value = preference;
    }
  };
  if (select) {
    select.replaceChildren(new Option(t('locale.auto'), 'auto'), ...LOCALES.map(item => new Option(item.name, item.code)));
    select.setAttribute('aria-label', t('locale.label'));
  }
  const selectLocale = (next: unknown) => { preference = localePreference(next); setLocale(resolveLocale(preference, browserLanguage)); apply(); };
  const unsubscribe = onLocaleChange(apply);
  const storageChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (disposed || area !== 'local' || !Object.hasOwn(changes, UI_LOCALE_KEY)) return;
    revision++; selectLocale(changes[UI_LOCALE_KEY]?.newValue);
  };
  const onChange = () => {
    const ticket = ++revision; const next = localePreference(select?.value); selectLocale(next);
    const status = root.querySelector<HTMLElement>('[data-locale-status]');
    if (status) status.hidden = true;
    void browser.storage.local.set({ [UI_LOCALE_KEY]: next }).catch(() => {
      if (disposed || ticket !== revision) return;
      if (status) { status.setAttribute('data-i18n', 'locale.saveError'); status.textContent = t('locale.saveError'); status.hidden = false; }
    });
  };
  browser.storage.onChanged.addListener(storageChanged); select?.addEventListener('change', onChange);
  selectLocale('auto');
  const initial = revision;
  try { const stored = await browser.storage.local.get(UI_LOCALE_KEY); if (!disposed && initial === revision) selectLocale(stored[UI_LOCALE_KEY]); }
  catch { /* Browser-language fallback remains usable if storage cannot be read. */ }
  return () => { disposed = true; unsubscribe(); select?.removeEventListener('change', onChange); browser.storage.onChanged.removeListener(storageChanged); registrations.delete(root); };
}
