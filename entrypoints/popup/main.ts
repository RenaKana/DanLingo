import { browser } from 'wxt/browser';
import { onlineBudgetText } from '../../src/ui/online-budget';
import type { OnlineBudgetState } from '../../src/core/online-budget';
import type { AdapterDiagnostic, RuntimeStatus, Settings } from '../../src/core/types';
import { adapterDiagnosticText } from '../../src/core/adapter-diagnostic';
import { liveStatusText } from '../../src/ui/live-status';
import { mountTargetLanguageSelect } from '../../src/ui/languages';
import { initTheme } from '../../src/ui/theme';
import '../../src/ui/base.css';
import './popup.css';
import { initLocale, localizeMessage, t } from '../../src/i18n';
import { bindLocalizedText } from '../../src/ui/localized-text';

type PopupSettings = Pick<Settings, 'enabled' | 'displayMode' | 'targetLanguage'>;
type OverviewResponse = {
  ok?: boolean;
  error?: string;
  settings?: PopupSettings;
  hasKey?: boolean;
  status?: RuntimeStatus | null;
  errorMessage?: unknown;
  adapterDiagnostic?: AdapterDiagnostic | null;
  bilibiliLiveCandidate?: boolean;
  onlineBudget?: OnlineBudgetState;
};

const enabled = document.getElementById('enabled') as HTMLInputElement;
const language = document.getElementById('language') as HTMLSelectElement;
const languageSelect = mountTargetLanguageSelect(language);
const mode = document.getElementById('mode') as HTMLSelectElement;
const status = document.getElementById('status') as HTMLElement;
const metrics = document.getElementById('metrics') as HTMLElement;
const coverage = document.getElementById('coverage') as HTMLElement;
const scenario = document.getElementById('scenario') as HTMLElement;
const quickControls = [enabled, language, mode];
void initLocale(document);
const themeDisposer = initTheme(document.getElementById('theme') as HTMLButtonElement);

const labels: Record<RuntimeStatus['state'], string> = {
  unsupported: 'm_bd90a6715dea',
  disabled: 'm_f2b5a88401b4',
  'configuration-needed': 'm_89baf1f67c7c',
  'finding-player': 'm_a8fb4de9f34a',
  ready: 'm_6641a8be0bf2',
  translating: 'm_3d6100cd2329',
  degraded: 'm_7e354d90714c',
};

let disposed = false;
let busy = false;
let interactionDirty = false;
let failedInteractionRevision: number | undefined;
let interactionRevision = 0;
let refreshTicket = 0;
let openingSettings = false;
let settingsOpenError = false;

function errorMessage(error: unknown, fallback: string) {
  const rendered = localizeMessage(error);
  return rendered === t('error.unknown') ? fallback : rendered;
}

function setStatus(text: string | (() => string), error = false) {
  bindLocalizedText(status, typeof text === 'function' ? text : () => text);
  status.classList.toggle('error', error);
  document.body.dataset.status = error ? 'error' : 'normal';
}

function setQuickControlsDisabled(disabled: boolean) {
  enabled.disabled = mode.disabled = disabled;
  languageSelect.setDisabled(disabled);
  document.querySelector('.popup-controls')?.setAttribute('aria-busy', String(disabled));
}

function applySettings(next: PopupSettings) {
  enabled.checked = next.enabled === true;
  mode.value = next.displayMode === 'original' ? 'original' : 'translated';
  const targetLanguage = typeof next.targetLanguage === 'string' && next.targetLanguage ? next.targetLanguage : 'zh-Hans';
  languageSelect.setValue(targetLanguage);
}

function renderOverview(response: OverviewResponse) {
  const budget = document.getElementById('online-budget-status');
  if (budget) bindLocalizedText(budget, () => onlineBudgetText(response.ok ? response.onlineBudget : undefined));
  if (!response.ok) {
    setStatus(() => {
      const rendered = localizeMessage(response.errorMessage ?? response.error);
      return rendered === t('error.unknown') ? t('m_8a9091e1ce96') : rendered;
    }, true);
    bindLocalizedText(metrics, () => '');
    coverage.hidden = true;
    return;
  }

  const current = response.status;
  const isLive = current?.scenario === 'live';
  const diagnostic = response.adapterDiagnostic;
  setStatus(() => !response.hasKey ? t('m_89baf1f67c7c')
    : isLive ? liveStatusText(current!).state
      : current ? labels[current.state] ? t(labels[current.state]) : localizeMessage(current.noteMessage ?? current.note) || t('m_c463b68e64bb')
      : diagnostic ? adapterDiagnosticText(diagnostic)
      : response.bilibiliLiveCandidate ? t('m_161e85ac1a8d') : t('m_bd162b1e0020'));
  bindLocalizedText(scenario, () => isLive || response.bilibiliLiveCandidate ? t('m_e472b37cf9ad') : current?.scenario === 'video' || diagnostic ? t('m_c20f7618d330') : t('m_0e541bff221e'));
  bindLocalizedText(metrics, () => isLive ? liveStatusText(current!).metrics
    : current ? t('m_a466e7c1cc38', { p0: current.prepared ?? 0, p1: current.messages, p2: current.nearPrepared ?? 0, p3: current.nearTotal ?? 0, p4: current.queued }) : '');
  bindLocalizedText(coverage, () => isLive ? liveStatusText(current!).coverage : '');
  coverage.hidden = !isLive;
  if (response.settings) applySettings(response.settings);
}

async function refresh() {
  if (disposed || busy || interactionDirty || openingSettings || settingsOpenError) return;
  const ticket = ++refreshTicket;
  const revision = interactionRevision;
  try {
    const response = await browser.runtime.sendMessage({ type: 'overview' }) as OverviewResponse;
    if (disposed || ticket !== refreshTicket || revision !== interactionRevision || busy || interactionDirty || openingSettings || settingsOpenError
      || failedInteractionRevision !== undefined) return;
    renderOverview(response);
  } catch (error) {
    if (disposed || ticket !== refreshTicket || revision !== interactionRevision || busy || interactionDirty || openingSettings || settingsOpenError
      || failedInteractionRevision !== undefined) return;
    setStatus(() => errorMessage(error, t('m_8a9091e1ce96')), true);
    bindLocalizedText(metrics, () => '');
    coverage.hidden = true;
  }
}

async function applyQuickSettings() {
  if (disposed || busy) return;
  settingsOpenError = false;
  const revision = ++interactionRevision;
  interactionDirty = true;
  failedInteractionRevision = undefined;
  refreshTicket++;
  busy = true;
  setQuickControlsDisabled(true);
  setStatus(() => t('m_2d69d60095d2'));

  const payload = { enabled: enabled.checked, targetLanguage: languageSelect.value(), displayMode: mode.value };
  try {
    const response = await browser.runtime.sendMessage({ type: 'toggle', ...payload }) as OverviewResponse;
    if (disposed || revision !== interactionRevision) return;
    if (!response?.ok) throw new Error(response?.error || t('m_38b66054dd5e'));
    if (response.settings) applySettings(response.settings);
    interactionDirty = false;
    failedInteractionRevision = undefined;
  } catch (error) {
    if (revision === interactionRevision && !disposed) {
      failedInteractionRevision = revision;
      setStatus(() => errorMessage(error, t('m_708a34be0197')), true);
    }
    return;
  } finally {
    if (revision === interactionRevision) {
      busy = false;
      setQuickControlsDisabled(false);
    }
  }
  if (!disposed && revision === interactionRevision) await refresh();
}

for (const element of quickControls) element.addEventListener('change', () => { void applyQuickSettings(); });
language.addEventListener('input', () => {
  if (disposed || busy) return;
  interactionDirty = true;
  failedInteractionRevision = undefined;
  interactionRevision++;
  refreshTicket++;
});

document.getElementById('settings')?.addEventListener('click', async () => {
  if (openingSettings) return;
  openingSettings = true; settingsOpenError = false;
  try {
    const result = await browser.runtime.sendMessage({ type: 'open-settings' });
    if (!result?.ok) throw new Error(result?.error || t('m_e07f2e4b2b94'));
    window.close();
  } catch (error) { settingsOpenError = true; setStatus(() => errorMessage(error, t('m_e07f2e4b2b94')), true); }
  finally { openingSettings = false; }
});

const timer = setInterval(() => { void refresh(); }, 1500);
const onRuntimeMessage = (message: unknown) => {
  if (!message || typeof message !== 'object' || (message as { type?: unknown }).type !== 'settings-updated') return;
  if (!busy && !interactionDirty && failedInteractionRevision === undefined) void refresh();
};
browser.runtime.onMessage.addListener(onRuntimeMessage);

void refresh();

window.addEventListener('pagehide', () => {
  disposed = true;
  clearInterval(timer);
  browser.runtime.onMessage.removeListener(onRuntimeMessage);
  themeDisposer();
});
