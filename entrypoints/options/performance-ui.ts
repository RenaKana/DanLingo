import { browser } from 'wxt/browser';
import { endpointOrigin } from '../../src/core/config';
import type { LocalModelInfo } from '../../src/local/types';
import type { Settings } from '../../src/core/types';
import type { PerformanceReport } from '../../src/translation/performance-test';
import { translationLanguageMessage } from '../../src/local/translation-profile';
import { getLocale, localize, localizeMessage, t, UiError } from '../../src/i18n';
import { bindLocalizedText } from '../../src/ui/localized-text';
import { mountPerformanceHistoryUI } from './performance-history-ui';
import { mountPerformanceControls } from './performance-controls';

interface BatchStatus {
  id: string; state: 'running' | 'completed' | 'stopped' | 'failed';
  phase: 'preparing' | 'unloading' | 'loading' | 'testing' | 'saving' | 'finishing' | 'done';
  index: number; total: number; completed: number; modelId?: string; modelName?: string; error?: string; errorCode?: string;
}

export function mountPerformanceUI(options: { container: HTMLElement; activity(active: boolean): void; readSettings(backend: 'local' | 'online', model?: string): Settings; readKey(): string; configureOnline(): void }) {
  const panel = document.createElement('section'); panel.className = 'card performance-panel';
  panel.innerHTML = `<style>.performance-panel [hidden]{display:none!important}</style><h2 data-i18n="m_54e55eca2b82">翻译性能测试</h2>
    <div class="row" style="margin-top:16px"><button id="performance-start" type="button" data-i18n="m_69ed375721d9">开始测试</button><button id="performance-stop" type="button" disabled data-i18n="m_ca4d973c0b00">停止</button><button id="performance-copy" type="button" disabled data-i18n="m_b93a1c638ab1">复制结果</button></div>
    <div id="performance-progress" class="status" role="status" aria-live="polite"></div>
    <details><summary data-i18n="m_527ceb75665e">完整测试结果</summary><div id="performance-result" class="status" style="white-space:pre-line" role="status"></div></details>
    <div id="performance-copy-status" class="status" role="status" aria-live="polite"></div>
    <label id="performance-copy-fallback" hidden><span data-i18n="m_c63350797f3f">手动复制测试结果</span><textarea id="performance-copy-text" readonly rows="6" spellcheck="false" style="width:100%;box-sizing:border-box"></textarea></label>
    <p class="subtle" data-help="m_7c185a12004e" data-i18n="settings.performanceNote">测试会暂停翻译，并可能产生费用。</p>
<p data-help="m_7c185a12004e" data-i18n="performance.windowNote"></p>
<p data-help="m_7c185a12004e" data-i18n="m_bfbe8e2e0113"></p>
<p data-help="m_7c185a12004e" data-i18n="m_f40de1e91de6"></p>
`;
  options.container.append(panel);
  localize(panel);
  const controls = mountPerformanceControls(panel, options.configureOnline);
  const history = mountPerformanceHistoryUI(panel);
  for (const control of panel.querySelectorAll('input,select')) control.setAttribute('form', 'performance-controls');
  const field = (id: string) => panel.querySelector<HTMLInputElement>('#performance-' + id)!;
  const button = (id: string) => panel.querySelector<HTMLButtonElement>('#performance-' + id)!;
  const progress = field('progress'), result = field('result');
  const copyStatus = field('copy-status'), copyFallback = field('copy-fallback');
  const copyText = panel.querySelector<HTMLTextAreaElement>('#performance-copy-text')!;
  let copyVersion = 0;
  function clearCopy() { copyVersion++; copyStatus.className = 'status'; bindLocalizedText(copyStatus, () => ''); copyFallback.hidden = true; copyText.value = ''; }
  function legacyCopy(text: string): boolean {
    const previous = document.activeElement;
    const input = document.createElement('textarea'); input.value = text; input.readOnly = true;
    input.style.cssText = 'position:fixed;opacity:0;pointer-events:none'; panel.append(input);
    try { input.focus({ preventScroll: true }); input.select(); return document.execCommand('copy'); }
    catch { return false; }
    finally { input.remove(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); }
  }
  let report: PerformanceReport | null = null, resultReport: PerformanceReport | null = null, polling = false, starting = false, saveState: string | null = null, timer: ReturnType<typeof setTimeout> | undefined;
  let batch: BatchStatus | null = null, stopRequested = false;
  const batchActive = () => !!batch && batch.phase !== 'done';
  const active = () => starting || batchActive() || !batch && report?.state === 'running';
  const fixed = (value: number, digits: number) => new Intl.NumberFormat(getLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  const ms = (value: number | null) => value === null ? t('m_eedf1535062b') : `${fixed(value, 1)} ms`;
  const rate = (value: number | null) => value === null ? t('m_eedf1535062b') : `${fixed(value * 100, 1)}%`;
  const setStatus = (render: () => string, error = false) => { progress.className = error ? 'status error' : 'status'; bindLocalizedText(progress, render); };
  const testError = (code: string): string => {
    if (/^PERFORMANCE_BATCH_[A-Z_]+$/.test(code)) {
      const key = `performance.error.${code}`, message = t(key);
      return message !== key ? message : t('performance.phase.failed');
    }
    return localizeMessage(translationLanguageMessage(code) ?? code);
  };
  function reportText(next: PerformanceReport | null): string {
    if (!next) return '';
    const rejected = next.samples.filter(sample => sample.sentAt === null && sample.status === 'failed' && sample.reason);
    const reasons = [...new Set(rejected.map(sample => sample.reason!))];
    const displayError = (reason: string) => localizeMessage(translationLanguageMessage(reason) ?? reason);
    const noRequests = next.state === 'completed' && next.actualRequests === 0;
    const lines = [
      ...(next.backend === 'local' ? [t('m_0345adac7151', { p0: next.localInferenceCalls ?? t('m_10e9fccc034f') })] : []),
      `${next.model} · ${next.backend === 'local' ? t('m_0928107b7d67') : t('m_1760b98532ec')} · ${next.config.strategy === 'superchat' ? 'Super Chat' : t('m_03287b455f2d')}`,
      t('m_a2e10ab61089', { p0: ms(next.meanMs), p1: next.successRequests, p2: ms(next.p50Ms), p3: ms(next.p95Ms) }),
      t('m_737edf2203cd', { p0: rate(next.successRate), p1: next.failed, p2: next.timeout, p3: next.cancelled, p4: next.unsent }),
      ...(rejected.length ? [t('m_19f59e23513f', { p0: rejected.length, p1: reasons.map(displayError).join('；') })] : []),
      t('m_520b8c36998d', { p0: fixed(next.throughput, 2), p1: ms(next.firstRequestMs), p2: ms(next.stableMeanMs) }),
      ...(next.config.mode === 'load' ? [t('m_49c35a7e2415', { p0: ms(next.meanQueueMs), p1: ms(next.meanReadyMs), p2: rate(next.withinBudgetRate) })] : []),
      ...(next.timing ? [
        `${t('performance.firstValid')}: ${ms(next.timing.firstValidMs)}`,
        t('performance.firstWindow', { one: next.timing.readyWithin1s, two: next.timing.readyWithin2s, five: next.timing.readyWithin5s, total: next.timing.plannedItems }),
        t('performance.itemSpeed', { count: next.timing.validItems, speed: fixed(next.timing.itemsPerSecond, 2), mean: ms(next.timing.meanItemReadyMs), p95: ms(next.timing.p95ItemReadyMs) }),
      ] : []),
      next.usage ? t('m_c8137ad1ad80', { p0: JSON.stringify(next.usage), p1: next.usageReports, p2: next.actualRequests }) : t('m_7b55c94a4eba'),
      ...(next.config.count <= 10 ? [t('m_c953904e3580')] : []),
    ];
    return lines.join('\n');
  }
  function render(next: PerformanceReport | null) {
    if (next?.id !== report?.id) clearCopy();
    report = next; resultReport = next;
    history.update(next, saveState);
    const busy = !!active();
    options.activity(busy);
    button('start').disabled = busy; button('stop').disabled = !busy || stopRequested; button('copy').disabled = !next;
    controls.setBusy(busy);
    bindLocalizedText(result, () => reportText(resultReport));
    if (batch && (batch.phase !== 'testing' || !next)) {
      const current = batch;
      setStatus(() => t('performance.batchProgress', { index: Math.min(current.total, current.index + 1), total: current.total,
        model: current.modelName ?? '', phase: stopRequested && current.phase !== 'done' ? t('performance.phase.stopping') : t(`performance.phase.${current.phase === 'done' ? current.state : current.phase}`) }) +
        (current.errorCode || current.error ? ` · ${testError(current.errorCode ?? current.error!)}` : ''), current.state === 'failed');
      return;
    }
    if (!next) return;
    const rejected = next.samples.filter(sample => sample.sentAt === null && sample.status === 'failed' && sample.reason);
    const reasons = [...new Set(rejected.map(sample => sample.reason!))];
    const displayError = (reason: string) => localizeMessage(translationLanguageMessage(reason) ?? reason);
    const noRequests = next.state === 'completed' && next.actualRequests === 0;
    setStatus(() => (batch ? `${batch.index + 1}/${batch.total} · ${batch.modelName ?? next.model} · ` : '') +
      (stopRequested ? t('performance.phase.stopping') : t('m_4e1d622c7c9f', { p0: next.state === 'running' ? t('m_458748c7478e') : next.state === 'stopped' ? t('m_f006455e3baf') : noRequests ? t('m_774eb70ea920') : t('m_f28461bb49c8'), p1: next.completed, p2: next.planned, p3: next.actualRequests, p4: next.stopReason ? ' · ' + localizeMessage(next.stopReason) : '', p5: reasons.length ? ' · ' + reasons.map(displayError).join('；') : '' })), noRequests || rejected.length > 0);
  }
  async function poll() {
    if (polling || document.hidden) return;
    polling = true;
    try { const response = await browser.runtime.sendMessage({ type: 'performance-status' }); if (response?.ok) {
      saveState = response.saveState ?? null; batch = response.batch ?? null;
      if (batch?.phase === 'done') stopRequested = false;
      render(response.report);
    } }
    catch { setStatus(() => t('m_b9e52f746701'), true); }
    finally { polling = false; clearTimeout(timer); if (active() || saveState === 'pending') timer = setTimeout(() => { void poll(); }, 350); }
  }
  button('start').addEventListener('click', async () => {
    if (active()) return;
    try {
      if (!controls.validate()) return;
      const settings = controls.settings(options.readSettings(controls.backend(), controls.onlineModel())), config = controls.config(), modelIds = controls.modelIds();
      if (settings.backend === 'online' && !settings.endpoint.trim()) throw new UiError('performance.configureOnline');
      starting = true; stopRequested = false; batch = null; clearCopy(); options.activity(true);
      button('start').disabled = true; button('stop').disabled = false; controls.setBusy(true);
      resultReport = null; bindLocalizedText(result, () => reportText(resultReport)); setStatus(() => t('m_619668063562'));
      if (settings.backend !== 'local' && !await browser.permissions.request({ origins: [endpointOrigin(settings.endpoint, settings.allowLocalHttp) + '/*'] })) throw new UiError('m_5c6b58748487');
      if (stopRequested) return;
      const response = await browser.runtime.sendMessage({ type: 'performance-start', settings, apiKey: settings.backend === 'local' ? undefined : options.readKey(), config, modelIds });
      if (!response?.ok) throw response?.error ? new Error(response.error) : new UiError('m_bde39f69604a');
      starting = false; saveState = response.saveState ?? null; batch = response.batch ?? null;
      if (stopRequested) await browser.runtime.sendMessage({ type: 'performance-stop' });
      render(response.report); await poll();
    } catch (error) { setStatus(() => error instanceof UiError ? t(error.uiMessage.id, error.uiMessage.params) : error instanceof Error ? testError(error.message) : t('m_6207c498142d'), true); }
    finally {
      starting = false; const busy = !!active();
      button('start').disabled = busy; button('stop').disabled = !busy || stopRequested; controls.setBusy(busy); options.activity(busy);
    }
  });
  button('stop').addEventListener('click', async () => {
    stopRequested = true; button('stop').disabled = true; setStatus(() => t('performance.phase.stopping'));
    try { await browser.runtime.sendMessage({ type: 'performance-stop' }); await poll(); }
    catch { stopRequested = false; button('stop').disabled = !active(); setStatus(() => t('m_c07f14d15157'), true); }
  });
  button('copy').addEventListener('click', async () => {
    if (!report) return;
    clearCopy();
    const version = copyVersion, text = JSON.stringify(report, null, 2);
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch { /* Try selection-based copying below. */ }
    if (version !== copyVersion) return;
    if (!copied) copied = legacyCopy(text);
    copyStatus.className = copied ? 'status' : 'status error';
    bindLocalizedText(copyStatus, () => copied ? t('m_1a1b38152b64') : t('m_0e64105a2103'));
    if (!copied) { copyFallback.hidden = false; copyText.value = text; copyText.focus({ preventScroll: true }); copyText.select(); }
  });
  const onVisibilityChange = () => { if (!document.hidden) void poll(); };
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibilityChange); }, { once: true });
  void poll();
  return { sync(settings: Settings, models: LocalModelInfo[], onlineModels: string[] = []) { controls.sync(settings, models, onlineModels); } };
}
