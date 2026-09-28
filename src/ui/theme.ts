import { browser } from 'wxt/browser';
import { localizeMessage, onLocaleChange, t } from '../i18n/text.ts';

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

function adjacentStatus(control?: HTMLSelectElement | HTMLButtonElement): HTMLElement | null {
  if (!control) return null;
  const parent = control.closest<HTMLElement>('[data-theme-control]') ?? control.parentElement;
  return parent?.querySelector<HTMLElement>('[data-theme-status]') ?? null;
}

const themeLabels: Record<ThemePreference, string> = {
  system: 'm_217cfe7db1e3',
  light: 'm_aa0819dfc4d8',
  dark: 'm_a6b75d068032',
};

const nextTheme: Record<ThemePreference, ThemePreference> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

/**
 * Apply and persist the UI theme without touching translation settings.
 * The returned disposer removes local listeners; it does not revert the theme.
 */
export function initTheme(control?: HTMLSelectElement | HTMLButtonElement): () => void {
  const button = control?.tagName === 'BUTTON' ? control as HTMLButtonElement : undefined;
  const select = button ? undefined : control as HTMLSelectElement | undefined;
  let preference: ThemePreference = 'system';
  let disposed = false;
  let interactionRevision = 0;
  let pendingWriteRevision: number | undefined;
  let writeQueue: Promise<void> = Promise.resolve();
  let storageRevision = 0;
  let mediaQuery: MediaQueryList | undefined;
  const status = adjacentStatus(control);
  let currentStatus = '';
  let currentError = false;

  const setStatus = (message: string, error = false) => {
    currentStatus = message; currentError = error;
    if (!status) return;
    status.textContent = localizeMessage(message);
    status.hidden = !message;
    status.classList.toggle('error', error);
  };
  const updateButtonLabel = () => {
    if (!button) return;
    const label = `${t('m_86a63f23a076')}: ${t(themeLabels[preference])} → ${t(themeLabels[nextTheme[preference]])}`;
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
  };
  const stopLocale = onLocaleChange(() => {
    setStatus(currentStatus, currentError);
    updateButtonLabel();
  });

  const apply = (next: ThemePreference) => {
    preference = next;
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = next === 'system' ? systemTheme() : next;
    }
    if (select && select.value !== next) select.value = next;
    if (button) button.dataset.themePreference = next;
    updateButtonLabel();
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
    if (!control) return;
    const next: ThemePreference = button ? nextTheme[preference]
      : isThemePreference(select?.value) ? select.value : 'system';
    const revision = ++interactionRevision;
    pendingWriteRevision = revision;
    apply(next);
    setStatus('');
    writeQueue = writeQueue.catch(() => {}).then(() => browser.storage.local.set({
      [UI_PREFERENCES_KEY]: { theme: next },
    }));
    void writeQueue.then(() => {
      if (revision === interactionRevision) pendingWriteRevision = undefined;
    }, () => {
      if (revision !== interactionRevision) return;
      pendingWriteRevision = undefined;
      if (!disposed) setStatus('外观设置未能保存，请重试', true);
    });
  };

  apply('system');
  select?.addEventListener('change', onChange);
  button?.addEventListener('click', onChange);
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
    stopLocale();
    select?.removeEventListener('change', onChange);
    button?.removeEventListener('click', onChange);
    browser.storage.onChanged.removeListener(onStorageChange);
    if (mediaQuery) {
      if (typeof mediaQuery.removeEventListener === 'function') mediaQuery.removeEventListener('change', onMediaChange);
      else mediaQuery.removeListener(onMediaChange);
    }
  };
}
