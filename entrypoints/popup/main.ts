import { browser } from 'wxt/browser';
import { onlineBudgetText } from '../../src/ui/online-budget';
import type { OnlineBudgetState } from '../../src/core/online-budget';
import type { AdapterDiagnostic, RuntimeStatus, Settings } from '../../src/core/types';
import { adapterDiagnosticText } from '../../src/core/adapter-diagnostic';
import { liveStatusText } from '../../src/ui/live-status';
import { initTheme } from '../../src/ui/theme';
import '../../src/ui/base.css';
import './popup.css';

type PopupSettings = Pick<Settings, 'enabled' | 'displayMode' | 'targetLanguage'>;
type OverviewResponse = {
  ok?: boolean;
  error?: string;
  settings?: PopupSettings;
  hasKey?: boolean;
  status?: RuntimeStatus | null;
  adapterDiagnostic?: AdapterDiagnostic | null;
  bilibiliLiveCandidate?: boolean;
  onlineBudget?: OnlineBudgetState;
};

const enabled = document.getElementById('enabled') as HTMLInputElement;
const language = document.getElementById('language') as HTMLSelectElement;
const mode = document.getElementById('mode') as HTMLSelectElement;
const status = document.getElementById('status') as HTMLElement;
const metrics = document.getElementById('metrics') as HTMLElement;
const coverage = document.getElementById('coverage') as HTMLElement;
const scenario = document.getElementById('scenario') as HTMLElement;
const quickControls = [enabled, language, mode];
const themeDisposer = initTheme(document.getElementById('theme') as HTMLSelectElement);

const labels: Record<string, string> = {
  unsupported: '请打开支持的视频或直播页面',
  disabled: '翻译已关闭',
  'configuration-needed': '请先配置翻译服务',
  'finding-player': '正在等待原生播放器',
  ready: '原生弹幕翻译已就绪',
  translating: '正在准备后续译文',
  degraded: '暂时使用原文',
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
  return error instanceof Error && error.message ? error.message : fallback;
}

function setStatus(text: string, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
  document.body.dataset.status = error ? 'error' : 'normal';
}

function setQuickControlsDisabled(disabled: boolean) {
  for (const control of quickControls) control.disabled = disabled;
  document.querySelector('.popup-controls')?.setAttribute('aria-busy', String(disabled));
}

function applySettings(next: PopupSettings) {
  enabled.checked = next.enabled === true;
  mode.value = next.displayMode === 'original' ? 'original' : 'translated';
  const targetLanguage = typeof next.targetLanguage === 'string' && next.targetLanguage ? next.targetLanguage : 'zh-Hans';
  if (![...language.options].some(option => option.value === targetLanguage)) {
    language.add(new Option(targetLanguage, targetLanguage));
  }
  language.value = targetLanguage;
}

function renderOverview(response: OverviewResponse) {
  const budget = document.getElementById('online-budget-status');
  if (budget) budget.textContent = onlineBudgetText(response.ok ? response.onlineBudget : undefined);
  if (!response.ok) {
    setStatus(response.error || '扩展后台未就绪', true);
    metrics.textContent = '';
    coverage.hidden = true;
    return;
  }

  const current = response.status;
  const live = current?.scenario === 'live' ? liveStatusText(current) : null;
  const diagnostic = response.adapterDiagnostic;
  setStatus(!response.hasKey ? '请先配置翻译服务'
    : live ? live.state
      : current ? labels[current.state] || current.note || '等待状态更新'
      : diagnostic ? adapterDiagnosticText(diagnostic)
      : response.bilibiliLiveCandidate ? '已识别 Bilibili 直播，正在等待原生直播间就绪' : '打开视频或直播页面开始观看');
  scenario.textContent = live || response.bilibiliLiveCandidate ? '直播' : current?.scenario === 'video' || diagnostic ? '视频' : '视频与直播';
  metrics.textContent = live ? live.metrics
    : current ? `已准备 ${current.prepared ?? 0}/${current.messages} · 近期 ${current.nearPrepared ?? 0}/${current.nearTotal ?? 0} · 队列 ${current.queued}` : '';
  coverage.textContent = live?.coverage ?? '';
  coverage.hidden = !live;
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
    setStatus(errorMessage(error, '扩展后台未就绪'), true);
    metrics.textContent = '';
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
  setStatus('正在应用设置…');

  const payload = { enabled: enabled.checked, targetLanguage: language.value, displayMode: mode.value };
  try {
    const response = await browser.runtime.sendMessage({ type: 'toggle', ...payload }) as OverviewResponse;
    if (disposed || revision !== interactionRevision) return;
    if (!response?.ok) throw new Error(response?.error || '设置未能应用');
    if (response.settings) applySettings(response.settings);
    interactionDirty = false;
    failedInteractionRevision = undefined;
  } catch (error) {
    if (revision === interactionRevision && !disposed) {
      failedInteractionRevision = revision;
      setStatus(errorMessage(error, '设置未能应用，请重试'), true);
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

document.getElementById('settings')?.addEventListener('click', async () => {
  if (openingSettings) return;
  openingSettings = true; settingsOpenError = false;
  try {
    const result = await browser.runtime.sendMessage({ type: 'open-settings' });
    if (!result?.ok) throw new Error(result?.error || '无法打开设置，请重试');
    window.close();
  } catch (error) { settingsOpenError = true; setStatus(errorMessage(error, '无法打开设置，请重试'), true); }
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
