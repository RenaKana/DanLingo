import type { Settings } from '../../src/core/types';
import type { LocalModelInfo } from '../../src/local/types';
import { normalizeLocalConfig, resolveLocalConfig } from '../../src/local/config';
import type { PerformanceConfig } from '../../src/translation/performance-test';
import { TARGET_LANGUAGES } from '../../src/ui/languages';
import { localize, t, UiError } from '../../src/i18n';

/** Test-only drafts: never write the saved translation configuration. */
export function mountPerformanceControls(panel: HTMLElement, configureOnline: () => void) {
  const container = document.createElement('div'); container.className = 'performance-controls';
  container.innerHTML = `<style>
    .performance-models{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:6px;max-height:210px;overflow:auto;margin:8px 0 12px}
    .performance-models label{display:flex;align-items:center;gap:8px;min-width:0;overflow-wrap:anywhere;font-size:13px}
    .performance-models input[type=checkbox],.performance-preset input{width:auto;flex:none}
    .performance-controls fieldset{border:0;padding:0;margin:0 0 12px;min-width:0}
    .performance-preset{display:flex;gap:8px;align-items:center;margin:10px 0}.performance-controls .subtle{margin:6px 0 12px}
  </style>
  <div class="grid" style="margin-bottom:12px"><label><span>测试类型</span><select id="performance-backend"><option value="local">本地模型</option><option value="online">在线模型</option></select></label></div>
  <fieldset id="performance-online-field" hidden>
    <label><span>在线模型</span><input id="performance-online-model" type="text" list="performance-online-models" placeholder="选择或填写模型名称" autocomplete="off" maxlength="200" required></label>
    <datalist id="performance-online-models"></datalist>
    <div class="row" style="margin-top:8px"><span id="performance-online-service" class="subtle"></span><button id="performance-online-configure" type="button">配置在线服务</button></div>
    <p class="subtle">沿用翻译服务中的地址、密钥和思考设置。测试可能产生费用，结果会自动保存。</p>
  </fieldset>
  <fieldset id="performance-model-field" hidden><legend data-i18n="performance.models"></legend>
    <div id="performance-models" class="performance-models"></div><div id="performance-models-note" class="subtle"></div>
  </fieldset>
  <div class="grid">
    <label><span data-i18n="m_51ddb206311a"></span><input id="performance-count" type="number" min="1" max="1000" step="1" value="10" required></label>
    <label><span data-i18n="m_315ac7f2fde9"></span><select id="performance-mode"><option value="latency" data-i18n="m_b72f1335a2cd"></option><option value="load" data-i18n="m_00e8b7044637"></option></select></label>
    <label><span data-i18n="performance.requestConcurrency"></span><input id="performance-concurrency" type="number" min="1" max="64" step="1" value="1" required></label>
    <label><span data-i18n="m_020e1166edf8"></span><select id="performance-strategy"><option value="normal" data-i18n="m_03287b455f2d"></option><option value="superchat">Super Chat</option></select></label>
    <label><span data-i18n="performance.sourceLanguage"></span><select id="performance-source"><option value="auto">自动</option><option value="zh">中文</option><option value="ja">日本語</option><option value="en">English</option><option value="ko">한국어</option></select></label>
    <label><span data-i18n="performance.targetLanguage"></span><select id="performance-target"></select></label>
    <label data-load-only hidden><span data-i18n="m_bff00d8a22bf"></span><input id="performance-batch-size" type="number" min="1" max="200" step="1" value="2" required></label>
    <label data-load-only hidden><span data-i18n="m_7dd1a3c96092"></span><input id="performance-arrival" type="number" min="0" max="5000" step="1" value="100" required></label>
    <label data-load-only hidden><span data-i18n="performance.budget"></span><input id="performance-budget" type="number" min="100" max="120000" step="1" value="5000" required></label>
    <label data-test-local hidden><span data-i18n="performance.localParallel"></span><input id="performance-parallel" type="number" min="1" max="64" step="1" value="4" required></label>
    <label data-test-local hidden><span data-i18n="performance.contextTokens"></span><input id="performance-context" type="number" min="0" step="1" value="0" required></label>
    <label data-test-local hidden><span data-i18n="performance.promptMode"></span><select id="performance-prompt"><option value="auto">自动</option><option value="hy-mt">HY-MT</option><option value="json">JSON</option></select></label>
  </div>
  <label class="performance-preset"><input id="performance-burst" type="checkbox"><span data-i18n="performance.burst"></span></label>
  <p class="subtle" data-i18n="performance.burstExplanation"></p>
  <p class="subtle" data-i18n="performance.draftNote"></p>`;
  panel.querySelector('h2')!.after(container); localize(container);
  const field = (id: string) => container.querySelector<HTMLInputElement>('#performance-' + id)!;
  field('target').replaceChildren(...TARGET_LANGUAGES.map(option => new Option(option.label, option.value)));
  const models = field('models'), modelNote = field('models-note');
  let initialized = false, busy = false, local = false, modelSelectionTouched = false, modelSignature = '';
  let backendTouched = false, onlineModelTouched = false, endpoint = '';
  const selected = new Set<string>();
  const presetKeys = ['mode', 'batch-size', 'arrival', 'budget', 'strategy'] as const;
  let beforePreset: Record<string, string> | null = null;
  const burstMatches = () => field('mode').value === 'load' && field('batch-size').value === '1' &&
    field('arrival').value === '0' && field('budget').value === '5000' && field('strategy').value === 'normal';
  function updateMode() {
    for (const el of container.querySelectorAll<HTMLElement>('[data-load-only]')) el.hidden = field('mode').value !== 'load';
  }
  function updateBackend() {
    local = field('backend').value === 'local';
    field('model-field').hidden = !local;
    field('online-field').hidden = local;
    for (const el of container.querySelectorAll<HTMLElement>('[data-test-local]')) el.hidden = !local;
  }
  field('backend').addEventListener('change', () => { backendTouched = true; updateBackend(); });
  field('online-model').addEventListener('input', () => { onlineModelTouched = true; });
  field('online-configure').addEventListener('click', configureOnline);
  function setChoice(id: string, value: string) {
    const control = field(id) as unknown as HTMLSelectElement;
    if (![...control.options].some(option => option.value === value)) control.add(new Option(value, value));
    control.value = value;
  }
  function renderModels(list: LocalModelInfo[], currentId?: string) {
    if (!modelSelectionTouched && currentId && list.some(model => model.id === currentId)) { selected.clear(); selected.add(currentId); }
    const availableIds = new Set(list.filter(model => !model.availability || model.availability === 'ready').map(model => model.id));
    for (const id of selected) if (!availableIds.has(id)) selected.delete(id);
    const signature = JSON.stringify([list.map(model => [model.id, model.name, model.availability]), [...selected]]);
    if (signature === modelSignature) return;
    modelSignature = signature; models.replaceChildren();
    for (const model of list) {
      const row = document.createElement('label'), check = document.createElement('input'), name = document.createElement('span');
      check.type = 'checkbox'; check.value = model.id; check.checked = selected.has(model.id); check.dataset.modelId = model.id;
      check.dataset.unavailable = String(!availableIds.has(model.id)); check.disabled = busy || !availableIds.has(model.id);
      check.setAttribute('form', 'performance-controls'); name.textContent = model.name + (availableIds.has(model.id) ? '' : ' · ' + t('performance.modelUnavailable'));
      check.addEventListener('change', () => {
        modelSelectionTouched = true; if (check.checked) selected.add(model.id); else selected.delete(model.id);
        modelSignature = ''; renderModelNote(list.length);
      });
      row.append(check, name); models.append(row);
    }
    renderModelNote(list.length);
  }
  function renderModelNote(total: number) {
    modelNote.textContent = total ? t('performance.modelQueueNote', { count: selected.size }) : t('performance.noModels');
  }
  field('burst').addEventListener('change', () => {
    if (field('burst').checked) {
      beforePreset = Object.fromEntries(presetKeys.map(key => [key, field(key).value]));
      field('mode').value = 'load'; field('batch-size').value = '1'; field('arrival').value = '0'; field('budget').value = '5000'; field('strategy').value = 'normal';
    } else if (beforePreset) {
      for (const key of presetKeys) field(key).value = beforePreset[key]!;
      beforePreset = null;
    }
    updateMode();
  });
  for (const key of presetKeys) for (const event of ['input', 'change']) field(key).addEventListener(event, () => {
    if (field('burst').checked && !burstMatches()) { field('burst').checked = false; beforePreset = null; }
    updateMode();
  });
  for (const control of container.querySelectorAll('input,select')) control.setAttribute('form', 'performance-controls');
  return {
    sync(settings: Settings, list: LocalModelInfo[], onlineModels: string[] = []) {
      if (!backendTouched) field('backend').value = settings.backend ?? 'online';
      updateBackend();
      if (endpoint !== settings.endpoint) { endpoint = settings.endpoint; onlineModelTouched = false; }
      if (!onlineModelTouched) field('online-model').value = settings.model;
      field('online-models').replaceChildren(...[...new Set([settings.model, ...onlineModels].filter(Boolean))].map(model => new Option(model, model)));
      let origin = '';
      try { origin = new URL(endpoint).origin; } catch { /* Empty or invalid service gets the configuration hint. */ }
      field('online-service').textContent = origin ? `当前服务：${origin}` : '尚未配置在线服务地址';
      if (!initialized) {
        const requested = normalizeLocalConfig(settings.localPerformance), runtime = resolveLocalConfig(requested, settings.localModelId);
        setChoice('source', settings.liveSourceLanguage); setChoice('target', settings.targetLanguage);
        field('parallel').value = String(runtime.parallel);
        const usesRecommendation = requested.mode === 'auto' && requested.autoRecommendation?.modelId === settings.localModelId;
        field('context').value = String(requested.contextTokens === 'auto' && ['auto', 'custom'].includes(requested.mode) && !usesRecommendation ? 0 : runtime.contextTokens);
        field('prompt').value = requested.promptMode; initialized = true;
      }
      renderModels(list, settings.localModelId);
    },
    validate() {
      for (const input of container.querySelectorAll<HTMLInputElement>('input')) if (!input.closest('[hidden]') && !input.reportValidity()) return false;
      if (local && !selected.size) throw new UiError('performance.chooseModels');
      if (local && selected.size > 20) throw new UiError('performance.tooManyModels');
      if (!local && !field('online-model').value.trim()) throw new UiError('performance.chooseOnlineModel');
      return true;
    },
    config(): PerformanceConfig {
      return { count: Number(field('count').value), mode: field('mode').value as PerformanceConfig['mode'],
        concurrency: Number(field('concurrency').value), batchSize: Number(field('batch-size').value),
        arrivalIntervalMs: Number(field('arrival').value), strategy: field('strategy').value as PerformanceConfig['strategy'],
        ...(field('mode').value === 'load' ? { budgetMs: Number(field('budget').value) } : {}) };
    },
    settings(base: Settings): Settings {
      const runtime = resolveLocalConfig(base.localPerformance, base.localModelId);
      return { ...base, liveSourceLanguage: field('source').value, targetLanguage: field('target').value,
        ...(base.backend === 'local' ? { localModelId: [...selected][0], localPerformance: {
          ...base.localPerformance, mode: 'custom', batchPreset: 'custom', batch: runtime.batch, microBatch: runtime.microBatch,
          flashAttention: runtime.flashAttention, cpuThreads: runtime.cpuThreads,
          parallel: Number(field('parallel').value),
          contextTokens: Number(field('context').value) === 0 ? 'auto' : Number(field('context').value),
          promptMode: field('prompt').value as 'auto' | 'hy-mt' | 'json',
        } } : {}) };
    },
    modelIds: () => local ? [...selected] : undefined,
    backend: () => local ? 'local' as const : 'online' as const,
    onlineModel: () => local ? undefined : field('online-model').value.trim(),
    setBusy(value: boolean) {
      busy = value;
      for (const el of container.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')) el.disabled = value || el.dataset.unavailable === 'true';
      (field('online-configure') as unknown as HTMLButtonElement).disabled = value;
    },
  };
}
