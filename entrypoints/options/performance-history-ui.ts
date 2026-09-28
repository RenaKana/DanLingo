import { browser } from 'wxt/browser';
import { performanceRecord, type PerformanceRecord } from '../../src/translation/performance-history';
import type { PerformanceReport } from '../../src/translation/performance-test';
import { formatDate, getLocale, localize, onLocaleChange, t } from '../../src/i18n';

/** Local summaries only; no settings, credentials, sample text or provider URLs. */
export function mountPerformanceHistoryUI(container: HTMLElement) {
  const section = document.createElement('section');
  section.className = 'performance-history';
  section.innerHTML = `<style>
    .performance-history{margin-top:18px;padding-top:14px;border-top:1px solid var(--border);min-width:0}
    .performance-history .history-heading{padding:4px 0}
    .performance-history .history-heading-content{display:inline-flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px 12px;width:calc(100% - 1.2em);vertical-align:middle}
    .performance-history .history-heading-title{font-size:15px;font-weight:600;color:var(--text)}
    .performance-history .history-content{padding-top:12px}
    .performance-history .history-list{display:grid;min-width:0}
    .performance-history .history-record{min-width:0;border-bottom:1px solid var(--line,#ddd)}
    .performance-history .history-record details{min-width:0;padding:6px 0}
    .performance-history .history-summary{cursor:pointer;padding:3px 2px}
    .performance-history .history-summary:focus-visible{outline:2px solid var(--accent,#276ef1);outline-offset:2px;border-radius:2px}
    .performance-history .history-summary-line{display:inline-flex;align-items:center;flex-wrap:wrap;gap:4px 10px;width:calc(100% - 1.2em);min-width:0;vertical-align:middle}
    .performance-history .history-model{flex:1 1 140px;min-width:0;font-size:15px;font-weight:700;color:var(--text,#222);overflow-wrap:anywhere}
    .performance-history .history-time{flex:0 1 auto;margin-inline-start:auto;font-size:11px;color:var(--muted,#666);overflow-wrap:anywhere}
    .performance-history .history-body{min-width:0;padding:8px 0 4px 18px}
    .performance-history .history-expanded-header{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0}
    .performance-history .history-state{font-size:11px;color:var(--muted,#666)}
    .performance-history .history-delete{flex:none;padding:4px 8px;font-size:12px}
    .performance-history .history-metrics,.performance-history .history-conditions,.performance-history .history-outcomes{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,140px),1fr));gap:6px 12px;min-width:0;margin-top:8px}
    .performance-history .history-conditions{padding-top:8px;border-top:1px solid var(--line,#ddd)}
    .performance-history .history-item{min-width:0;overflow-wrap:anywhere}
    .performance-history .history-label{display:block;font-size:11px;color:var(--muted,#666)}
    .performance-history .history-value{display:block;overflow-wrap:anywhere}
    .performance-history .history-sample{grid-column:1 / -1;font-size:10px;color:var(--muted,#666)}
  </style>
    <div id="performance-save-status" class="status" role="status" aria-live="polite"></div>
    <button id="performance-retry-save" type="button" data-i18n="performance.retrySave" hidden></button>
    <details id="performance-history-disclosure">
    <summary class="history-heading"><span class="history-heading-content"><span class="history-heading-title" data-i18n="performance.history"></span><span id="performance-history-status" class="subtle" role="status" aria-live="polite"></span></span></summary>
    <div class="history-content">
    <div class="row"><button type="button" id="performance-export" data-i18n="performance.export" disabled></button></div>
    <p class="subtle" data-i18n="performance.historyNote"></p>
    <div id="performance-history-action-status" class="status" role="status" aria-live="polite"></div>
    <div id="performance-history-rows" class="history-list" role="list"></div>
    </div></details>`;
  container.append(section);
  localize(section);

  const rows = section.querySelector<HTMLElement>('#performance-history-rows')!;
  const status = section.querySelector<HTMLElement>('#performance-history-status')!;
  const actionStatus = section.querySelector<HTMLElement>('#performance-history-action-status')!;
  const saveStatus = section.querySelector<HTMLElement>('#performance-save-status')!;
  const exportButton = section.querySelector<HTMLButtonElement>('#performance-export')!;
  const retry = section.querySelector<HTMLButtonElement>('#performance-retry-save')!;
  let records: PerformanceRecord[] = [], current: PerformanceReport | null = null;
  let saveState: string | null = null, loaded = false, loadFailed = false, actionFailed = false, disposed = false, revision = 0;
  const expandedIds = new Set<string>();
  const deleting = new Set<string>();
  const deletedIds = new Set<string>();
  const number = (n: number) => new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }).format(n);
  const ms = (n: number | null) => n === null ? '—' : `${number(n)} ms`;

  function item(label: string, value: string, className = '') {
    const wrapper = document.createElement('div');
    wrapper.className = `history-item${className ? ' ' + className : ''}`;
    const name = document.createElement('span'); name.className = 'history-label'; name.textContent = label;
    const text = document.createElement('span'); text.className = 'history-value'; text.textContent = value;
    wrapper.append(name, text);
    return wrapper;
  }

  function renderRecord(record: PerformanceRecord) {
    const article = document.createElement('article');
    article.className = 'history-record'; article.dataset.recordId = record.id; article.setAttribute('role', 'listitem');

    const details = document.createElement('details');
    details.open = expandedIds.has(record.id);
    details.addEventListener('toggle', () => {
      if (!details.isConnected) return;
      if (details.open) expandedIds.add(record.id);
      else expandedIds.delete(record.id);
    });
    const summary = document.createElement('summary'); summary.className = 'history-summary';
    summary.addEventListener('click', () => {
      if (details.open) expandedIds.delete(record.id);
      else expandedIds.add(record.id);
    });
    const summaryLine = document.createElement('span'); summaryLine.className = 'history-summary-line';
    const model = document.createElement('span'); model.className = 'history-model'; model.textContent = record.model;
    const state = document.createElement('span'); state.className = 'history-state'; state.textContent = t(record.state === 'stopped' ? 'm_f006455e3baf' : 'm_f28461bb49c8');
    const time = document.createElement('span'); time.className = 'history-time'; time.textContent = formatDate(record.wallStartedAt);
    const remove = document.createElement('button'); remove.className = 'history-delete'; remove.type = 'button';
    remove.textContent = t(deleting.has(record.id) ? 'performance.history.deleting' : 'performance.history.delete');
    remove.setAttribute('aria-label', t('performance.history.deleteAria', { model: record.model }));
    remove.title = t('performance.history.deleteTitle'); remove.disabled = deleting.has(record.id);
    remove.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      void deleteRecord(record.id);
    });
    summaryLine.append(model, time, remove); summary.append(summaryLine);

    const body = document.createElement('div'); body.className = 'history-body';
    const expandedHeader = document.createElement('div'); expandedHeader.className = 'history-expanded-header';
    expandedHeader.append(state);

    const metrics = document.createElement('div'); metrics.className = 'history-metrics';
    metrics.append(
      item(t('performance.history.concurrency'), number(record.config.concurrency)),
      item(t('performance.firstValid'), ms(record.timing.firstValidMs)),
      item(t('performance.history.within2'), `${number(record.timing.readyWithin1s)} / ${number(record.timing.readyWithin2s)}`),
      item(t('performance.within5'), `${number(record.timing.readyWithin5s)} / ${number(record.timing.plannedItems)}`),
      item(t('performance.mean'), ms(record.meanMs)),
      item(t('performance.p95'), ms(record.p95Ms)),
      item(t('performance.history.itemsPerSecond'), number(record.timing.itemsPerSecond)),
    );

    const c = record.config, m = record.measurement, runtime = m.localRuntime;
    const mode = t(c.mode === 'load' ? 'm_00e8b7044637' : 'm_b72f1335a2cd');
    const strategy = c.strategy === 'superchat' ? 'Super Chat' : t('m_03287b455f2d');
    const batch = c.mode === 'latency' ? 1 : Math.min(c.batchSize, m.batchSize);
    const conditions = document.createElement('div'); conditions.className = 'history-conditions';
    const language = m.sourceLanguage === 'auto'
      ? `${t('performance.history.autoSample', { sample: m.sampleLanguage })} → ${m.targetLanguage}`
      : `${m.sourceLanguage} → ${m.targetLanguage}`;
    const prompt = runtime?.promptMode === 'hy-mt' ? 'HY-MT' : runtime?.promptMode === 'json' ? t('performance.history.structuredPrompt') : runtime ? t('performance.option.auto') : '—';
    const localTemplate = m.localTranslationProfile === 'seed-x' ? 'Seed-X'
      : m.localTranslationProfile === 'translategemma' ? 'TranslateGemma' : prompt;
    const profile = ({ deepseek: 'DeepSeek', minimax: 'MiniMax', gemini: 'Gemini', 'chat-completions': t('performance.history.compatibleProfile') } as Record<string, string>)[m.profile] ?? m.profile;
    const thinkingKey = ({ default: 'default', off: 'off', on: 'on', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'max', xhigh: 'xhigh' } as Record<string, string>)[m.thinkingEffort];
    const thinking = thinkingKey ? t('performance.history.thinking.' + thinkingKey) : m.thinkingEffort;
    conditions.append(
      item(t('performance.history.language'), language), item(t('performance.history.mode'), `${mode} · ${strategy}`), item(t('performance.history.tasks'), number(c.count)),
      item(t('performance.history.batch'), number(batch)), item(t('performance.history.arrival'), c.mode === 'load' ? `${number(c.arrivalIntervalMs)} ms` : t('performance.history.notApplicable')),
      item(t('performance.history.timeout'), `${number(m.requestTimeoutMs)} ms`), item(t('performance.history.budget'), `${number(m.budgetMs)} ms`),
      item(t('performance.history.profileThinking'), `${profile} / ${thinking}`),
    );
    if (record.backend === 'local') {
      conditions.append(
        item(t('performance.history.localParallel'), runtime ? number(runtime.parallel) : m.localCapacity === undefined ? t('performance.history.unrecorded') : number(m.localCapacity)),
        item(t('performance.history.localContext'), runtime ? number(runtime.contextTokens) : m.localContextTokens === undefined ? t('performance.history.unrecorded') : number(m.localContextTokens)),
        item(t('performance.history.localTemplate'), localTemplate),
      );
    }
    const sample = document.createElement('div'); sample.className = 'history-sample';
    sample.textContent = t('performance.history.fixedSample', { backend: t(record.backend === 'local' ? 'performance.controls.localModel' : 'performance.controls.onlineModel') });

    const outcomes = document.createElement('div'); outcomes.className = 'history-outcomes';
    outcomes.append(
      item(t('performance.history.successRequests'), `${number(record.successRequests)} / ${number(record.actualRequests)}`),
      item(t('performance.history.failed'), number(record.failed)), item(t('performance.history.timeoutCount'), number(record.timeout)),
      item(t('performance.history.cancelled'), number(record.cancelled)), item(t('performance.history.unsent'), number(record.unsent)),
    );
    body.append(expandedHeader, metrics, conditions, sample, outcomes);
    details.append(summary, body);
    article.append(details);
    return article;
  }

  function render() {
    rows.replaceChildren();
    records = records.filter(record => !deletedIds.has(record.id));
    for (const record of records) rows.append(renderRecord(record));
    status.textContent = loadFailed ? t('performance.historyFailed') : records.length ? t('performance.loadSaved', { count: records.length }) : t('performance.empty');
    status.className = loadFailed ? 'status error' : 'subtle';
    actionStatus.textContent = actionFailed ? t('performance.history.actionFailed') : '';
    actionStatus.className = actionFailed ? 'status error' : 'status';

    const terminal = current && current.state !== 'running';
    const currentDeleted = !!current && (deletedIds.has(current.id) || saveState === 'deleted');
    const canSave = !!terminal && !currentDeleted;
    saveStatus.textContent = !canSave ? '' : saveState === 'saved' ? t('performance.saved') : saveState === 'failed' ? t('performance.saveFailed') : saveState === 'pending' ? t('performance.saving') : '';
    saveStatus.className = saveState === 'failed' && canSave ? 'status error' : 'status';
    retry.hidden = !canSave || saveState !== 'failed';
    retry.disabled = !!current && deleting.has(current.id);
    const latest = canSave && !deleting.has(current!.id) ? performanceRecord(current!) : null;
    exportButton.disabled = !records.length && !latest;
  }

  async function refresh() {
    const ticket = ++revision;
    try {
      const response = await browser.runtime.sendMessage({ type: 'performance-history' });
      if (!response?.ok || !Array.isArray(response.records)) throw new Error('history-unavailable');
      if (disposed || ticket !== revision) return;
      records = response.records.filter((record: PerformanceRecord) => !deletedIds.has(record.id));
      loaded = true; loadFailed = false;
    } catch { if (!disposed && ticket === revision) loadFailed = true; }
    if (!disposed && ticket === revision) render();
  }

  async function deleteRecord(id: string) {
    if (deleting.has(id)) return;
    deleting.add(id); actionFailed = false; render();
    try {
      const response = await browser.runtime.sendMessage({ type: 'performance-history-delete', ids: [id] });
      if (!response?.ok) throw new Error('history-delete-failed');
      deletedIds.add(id);
      records = records.filter(record => record.id !== id);
      if (current?.id === id) saveState = 'deleted';
    } catch { actionFailed = true; }
    finally { deleting.delete(id); render(); await refresh(); }
  }

  retry.addEventListener('click', async () => {
    if (!current || deletedIds.has(current.id) || saveState === 'deleted' || deleting.has(current.id)) return;
    retry.disabled = true;
    try { const response = await browser.runtime.sendMessage({ type: 'performance-history-save' }); saveState = response?.ok ? 'saved' : 'failed'; }
    catch { saveState = 'failed'; }
    finally { retry.disabled = false; render(); await refresh(); }
  });

  exportButton.addEventListener('click', () => {
    const latest = current && !deletedIds.has(current.id) && saveState !== 'deleted' && !deleting.has(current.id)
      ? performanceRecord(current) : null;
    const exported = latest ? [latest, ...records.filter(record => record.id !== latest.id)] : records;
    const blob = new Blob([JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), records: exported }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `danlingo-model-tests-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    section.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  const unsubscribe = onLocaleChange(() => { localize(section); render(); });
  window.addEventListener('pagehide', () => { disposed = true; unsubscribe(); }, { once: true });
  render();
  return {
    update(next: PerformanceReport | null, saved: string | null = null) {
      if (next && saved === 'deleted') {
        deletedIds.add(next.id);
        records = records.filter(record => record.id !== next.id);
      }
      const nextSaveState = next && deletedIds.has(next.id) ? 'deleted' : saved;
      const changed = current?.id !== next?.id || current?.state !== next?.state || saveState !== nextSaveState;
      current = next; saveState = nextSaveState;
      if (changed || !loaded) render();
      if (!loaded || loadFailed || changed && (saveState === 'saved' || saveState === 'deleted')) void refresh();
    },
  };
}
