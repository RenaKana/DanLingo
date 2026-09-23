import { browser } from 'wxt/browser';

export const UI_PREFERENCES_KEY = 'ui.preferences.v1';

export type ThemePreference = 'system' | 'light' | 'dark';

type ThemePreferences = { theme?: unknown };
type ThemeStorageChange = { newValue?: unknown };

const isThemePreference = (value: unknown): value is ThemePreference =>
  value === 'system' || value === 'light' || value === 'dark';

function readThemePreference(value: unknown): ThemePreference {
  if (!value || typeof value !== 'object') return 'system';
  const theme = (value as ThemePreferences).theme;
  return isThemePreference(theme) ? theme : 'system';
}

function systemTheme(): Exclude<ThemePreference, 'system'> {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function adjacentStatus(select?: HTMLSelectElement): HTMLElement | null {
  if (!select) return null;
  const parent = select.closest<HTMLElement>('[data-theme-control]') ?? select.parentElement;
  return parent?.querySelector<HTMLElement>('[data-theme-status]') ?? null;
}

/**
 * Apply and persist the UI theme without touching translation settings.
 * The returned disposer removes local listeners; it does not revert the theme.
 */
export function initTheme(select?: HTMLSelectElement): () => void {
  let preference: ThemePreference = 'system';
  let disposed = false;
  let interactionRevision = 0;
  let pendingWriteRevision: number | undefined;
  let storageRevision = 0;
  let mediaQuery: MediaQueryList | undefined;
  const status = adjacentStatus(select);

  const setStatus = (message: string, error = false) => {
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle('error', error);
  };

  const apply = (next: ThemePreference) => {
    preference = next;
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = next === 'system' ? systemTheme() : next;
    }
    if (select && select.value !== next) select.value = next;
  };

  const onMediaChange = () => {
    if (!disposed && preference === 'system') apply('system');
  };

  const onStorageChange = (changes: Record<string, ThemeStorageChange>, areaName: string) => {
    if (disposed || areaName !== 'local') return;
    const change = changes[UI_PREFERENCES_KEY];
    if (!change) return;
    storageRevision++;
    if (pendingWriteRevision !== undefined) return;
    apply(readThemePreference(change.newValue));
    setStatus('');
  };

  const onChange = () => {
    if (!select) return;
    const next: ThemePreference = isThemePreference(select.value) ? select.value : 'system';
    const revision = ++interactionRevision;
    pendingWriteRevision = revision;
    apply(next);
    setStatus('');
    void browser.storage.local.set({ [UI_PREFERENCES_KEY]: { theme: next } }).catch(() => {
      if (revision !== interactionRevision) return;
      pendingWriteRevision = undefined;
      if (!disposed) setStatus('外观设置未能保存，请重试', true);
    }).then(() => {
      if (revision === interactionRevision) pendingWriteRevision = undefined;
    });
  };

  apply('system');
  select?.addEventListener('change', onChange);
  browser.storage.onChanged.addListener(onStorageChange);

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    if (typeof mediaQuery.addEventListener === 'function') mediaQuery.addEventListener('change', onMediaChange);
    else mediaQuery.addListener(onMediaChange);
  }

  const initialStorageRevision = storageRevision;
  void browser.storage.local.get(UI_PREFERENCES_KEY).then(stored => {
    if (disposed || interactionRevision > 0 || storageRevision !== initialStorageRevision) return;
    apply(readThemePreference(stored[UI_PREFERENCES_KEY]));
    setStatus('');
  }).catch(() => {
    if (!disposed && interactionRevision === 0) setStatus('外观设置读取失败，当前使用系统主题', true);
  });

  return () => {
    disposed = true;
    select?.removeEventListener('change', onChange);
    browser.storage.onChanged.removeListener(onStorageChange);
    if (mediaQuery) {
      if (typeof mediaQuery.removeEventListener === 'function') mediaQuery.removeEventListener('change', onMediaChange);
      else mediaQuery.removeListener(onMediaChange);
    }
  };
}
