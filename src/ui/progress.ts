import type { Settings } from '../core/types.ts';
import type { SchedulerStats } from '../core/scheduler.ts';
import { initLocale, localizeMessage, t } from '../i18n';
import { bindLocalizedAttribute, bindLocalizedText } from './localized-text.ts';
import { mountUserFilterStatus, type UserFilterStatusView } from './user-filter-status.ts';
import { mountDisplayPlan, type DisplayPlanView } from './display-plan.ts';
import { formatNumber } from '../i18n/text.ts';

type NativeSupplyProgressView = {
  visible: boolean;
  planned: boolean;
  state: string;
  status: string;
  actionText: string;
  actionHidden: boolean;
  actionDisabled: boolean;
  candidates?: unknown;
  selected?: unknown;
  submitted?: unknown;
  cacheHits?: unknown;
  adopted?: unknown;
  skipped?: unknown;
  hybrid?: Record<string, any> | null;
};

export function createProgress(onChange: (scope: Settings['translationScope'], seconds: number) => Promise<void>, onRetry: () => void,
  onDisplayPlan?: (enabled: boolean) => Promise<void>) {
  const host = document.createElement('div'); host.id = 'danlingo-progress';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host{all:initial;display:block;position:static;margin-top:8px;width:min(640px,100%);min-width:0;font:14px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;color:#343a40;color-scheme:light}
    :host([hidden]){display:none!important}*{box-sizing:border-box}#panel{width:100%;min-width:0;max-width:640px;padding:8px 10px;background:#fff;border:1px solid #d7dbe0;border-radius:6px}
    #progress-details{min-width:0}summary{cursor:pointer;padding:3px 0;list-style:none;display:flex;align-items:center;gap:8px;min-width:0;font-size:14px}summary::-webkit-details-marker{display:none}.expand-chevron{display:block;width:16px;height:16px;flex:none;margin-inline-start:auto;color:#68717c}#progress-details[open]>summary .expand-chevron{transform:rotate(180deg)}.mark{font-weight:700;color:#356da8}.body{padding:7px 0 4px;display:grid;gap:8px;min-width:0}
    #near-progress,#coverage,#filtered,#skipped,#native-stage,#scope-state{font-size:13px;color:#59616b}progress{width:100%;height:5px;accent-color:#4b83bd}
    label{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px}select,input,button{font:inherit;border:1px solid #c8cdd3;border-radius:5px;padding:4px 7px;background:#fff;color:#343a40}
    input{width:66px}button{cursor:pointer}button:disabled{opacity:.6}button:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #4b83bd;outline-offset:2px}
    #window-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}[hidden]{display:none!important}#note{color:#7a5b21;max-width:100%;overflow-wrap:anywhere;font-size:13px}
    #retry{justify-self:start}.body p{margin:0}summary:hover{color:#245b91}
    #native-supply-host{grid-column:1/-1;min-width:0;margin-top:7px;padding-top:9px;border-top:1px solid #e3e6ea;display:grid;gap:9px}#native-supply-host[hidden]{display:none!important}
    .supply-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 14px;align-items:start;min-width:0}.supply-heading{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}.supply-heading strong{font-size:14px;font-weight:600;color:#343a40}.supply-status{display:inline-flex;align-items:center;padding:0;color:#356da8;font-size:13px;overflow-wrap:anywhere}.supply-reason{grid-column:1/-1;margin:0;color:#4e5965;font-size:13px;overflow-wrap:anywhere}.supply-head button{font-size:13px;white-space:nowrap}
    .supply-grid,.hybrid-grid,.hybrid-shared{display:grid;grid-template-columns:repeat(auto-fit,minmax(82px,1fr));gap:0 12px;min-width:0;margin:0}.supply-grid>div,.hybrid-grid>div,.hybrid-shared>div{min-width:0;padding:4px 0;border:0;border-bottom:1px solid #eceef1;background:transparent}.supply-grid dt,.hybrid-grid dt,.hybrid-shared dt{font-size:13px;color:#59616b;overflow-wrap:anywhere}.supply-grid dd,.hybrid-grid dd,.hybrid-shared dd{margin:0;color:#343a40;font-size:15px;font-variant-numeric:tabular-nums;font-weight:600;overflow-wrap:anywhere}
    #hybrid-details{min-width:0;font-size:13px;color:#59616b}#hybrid-details>h4{margin:0;padding:2px 0;font-size:13px;font-weight:600}#hybrid-scope{margin:3px 0 7px;color:#68717c;font-size:13px}.hybrid-backends{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;min-width:0}.hybrid-backends section{min-width:0}.hybrid-backends h4{margin:0 0 4px;font-size:13px;font-weight:600;color:#4a5663}.hybrid-grid{grid-template-columns:repeat(auto-fit,minmax(76px,1fr));margin-bottom:7px}.hybrid-grid dd,.hybrid-shared dd{font-size:13px}
    #user-filter-host,#display-plan-host{display:none!important}
    @media(max-width:480px){#panel{padding:7px 8px}.supply-head{grid-template-columns:minmax(0,1fr)}.supply-head button{justify-self:start}.hybrid-backends{grid-template-columns:minmax(0,1fr)}}
  </style><div id="panel"><details id="progress-details"><summary aria-label="弹幕翻译进度" data-i18n-aria-label="m_1f18bfe5cca0"><span class="mark">译</span><span id="progress-summary" data-i18n="m_e3181e5e7f9c">读取评论池…</span><svg class="expand-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 5.5 5 5 5-5"/></svg></summary>
    <div class="body"><progress value="0" max="1" aria-label="弹幕准备进度" data-i18n-aria-label="m_b3cf881d96a6"></progress><span id="near-progress"></span>
    <div><p id="coverage"></p><p id="filtered" hidden></p><p id="skipped" hidden></p><p id="native-stage"></p><p id="scope-state"></p></div>
    <label><span data-i18n="m_84fe6685eb01">预译范围</span><select id="scope"><option value="auto" data-i18n="settings.videoScopeAuto">自动选择</option><option value="all" data-i18n="m_b99a7b08598a">整个评论池</option><option value="window" data-i18n="m_1927c994bd3f">提前 N 秒</option></select></label>
    <div id="window-row" hidden><label><span data-i18n="m_728e91804a2f">提前</span><input id="window-seconds" type="number" min="5" max="3600" step="1" aria-label="提前翻译秒数" data-i18n-aria-label="m_26c37c49fbd5"><span data-i18n="m_9dcdc2b289b9">秒</span></label><button id="apply-window" type="button" data-i18n="m_63c73c4730f4">应用</button></div>
    <p id="note" role="status" hidden></p><button id="retry" type="button" hidden data-i18n="m_70b1aaf12ba1">重试失败项</button></div>
    <section id="native-supply-host" hidden aria-label="提前供给状态">
      <div class="supply-head"><div class="supply-heading"><strong id="native-supply-title"></strong><span id="native-supply-status" class="supply-status"></span></div>
        <button id="native-supply-action" type="button" hidden></button><p id="native-supply-reason" class="supply-reason" role="status"></p></div>
      <dl class="supply-grid" id="supply-metrics">
        <div><dt data-i18n="progress.supply.candidates">候选</dt><dd id="supply-candidates">—</dd></div>
        <div><dt data-i18n="progress.supply.selected">入选</dt><dd id="supply-selected">—</dd></div>
        <div><dt data-i18n="progress.supply.submitted">提交输入</dt><dd id="supply-submitted">—</dd></div>
        <div><dt data-i18n="progress.supply.cacheHits">缓存命中</dt><dd id="supply-cache-hits">—</dd></div>
        <div><dt data-i18n="progress.supply.adopted">采用</dt><dd id="supply-adopted">—</dd></div>
        <div><dt data-i18n="progress.supply.skipped">跳过</dt><dd id="supply-skipped">—</dd></div>
      </dl>
      <section id="hybrid-details" hidden><h4 data-i18n="progress.supply.hybridSummary">混合后台统计</h4>
        <p id="hybrid-scope" data-i18n="progress.supply.hybridScope">本次运行 · 所有标签页</p>
        <div class="hybrid-backends">
          <section><h4 data-i18n="progress.supply.local">本地</h4><dl class="hybrid-grid">
            <div><dt data-i18n="progress.supply.actualRequests">实际请求</dt><dd id="hybrid-local-requests">—</dd></div>
            <div><dt data-i18n="progress.supply.inputItems">输入条目</dt><dd id="hybrid-local-items">—</dd></div>
            <div><dt data-i18n="progress.supply.inputChars">输入字符</dt><dd id="hybrid-local-chars">—</dd></div>
            <div><dt data-i18n="progress.supply.cacheHits">缓存命中</dt><dd id="hybrid-local-cache">—</dd></div>
            <div><dt data-i18n="progress.supply.timelyQualified">及时合格</dt><dd id="hybrid-local-timely">—</dd></div>
          </dl></section>
          <section><h4 data-i18n="progress.supply.online">在线</h4><dl class="hybrid-grid">
            <div><dt data-i18n="progress.supply.actualRequests">实际请求</dt><dd id="hybrid-online-requests">—</dd></div>
            <div><dt data-i18n="progress.supply.inputItems">输入条目</dt><dd id="hybrid-online-items">—</dd></div>
            <div><dt data-i18n="progress.supply.inputChars">输入字符</dt><dd id="hybrid-online-chars">—</dd></div>
            <div><dt data-i18n="progress.supply.cacheHits">缓存命中</dt><dd id="hybrid-online-cache">—</dd></div>
            <div><dt data-i18n="progress.supply.timelyQualified">及时合格</dt><dd id="hybrid-online-timely">—</dd></div>
          </dl></section>
        </div>
        <dl class="hybrid-shared">
          <div><dt data-i18n="progress.supply.subscriptions">事件订阅</dt><dd id="hybrid-subscriptions">—</dd></div>
          <div><dt data-i18n="progress.supply.uniqueTasks">独立任务</dt><dd id="hybrid-unique-tasks">—</dd></div>
          <div><dt data-i18n="progress.supply.mergedInputs">合并订阅</dt><dd id="hybrid-merged-inputs">—</dd></div>
          <div><dt data-i18n="progress.supply.expired">到期订阅</dt><dd id="hybrid-expired">—</dd></div>
        </dl>
      </section>
    </section></details></div><div id="user-filter-host" hidden></div><div id="display-plan-host" hidden></div>`;
  const localeReady = initLocale(root);
  const $ = <T extends HTMLElement>(id: string) => root.getElementById(id) as T;
  const details = $<HTMLDetailsElement>('progress-details');
  const scope = $<HTMLSelectElement>('scope'); const seconds = $<HTMLInputElement>('window-seconds');
  const apply = $<HTMLButtonElement>('apply-window'); const note = $('note');
  const userFilterHost = $('user-filter-host');
  const userFilterStatus = mountUserFilterStatus(userFilterHost);
  const displayPlanHost = $('display-plan-host');
  const displayPlan = mountDisplayPlan(displayPlanHost, onDisplayPlan);
  const renderPreviewHost = document.createElement('div');
  renderPreviewHost.id = 'render-preview-host'; displayPlanHost.append(renderPreviewHost);
  const nativeSupplyHost = $<HTMLElement>('native-supply-host');
  const nativeSupplyButton = $<HTMLButtonElement>('native-supply-action');
  let dirty = false; let saving = false; let localError = '';
  let resourceId = ''; let active = false;
  let bilibili = false; let userFilterView: UserFilterStatusView | null = null;
  let anchor: HTMLElement | null = null;
  function visibility() {
    userFilterHost.hidden = true;
    displayPlanHost.hidden = true;
    host.hidden = (!active && nativeSupplyHost.hidden) || !anchor?.isConnected || !!document.fullscreenElement;
    if (!host.hidden && anchor) {
      // Fail closed if the site's layout has changed: never become a video overlay again.
      const playerBox = anchor.getBoundingClientRect(), box = host.getBoundingClientRect();
      if (!playerBox.width || !playerBox.height || box.top < playerBox.bottom - 1) host.hidden = true;
    }
  }
  const resize = new ResizeObserver(visibility);
  document.addEventListener('fullscreenchange', visibility);
  async function save() {
    if (saving || !seconds.checkValidity()) { seconds.reportValidity(); return; }
    saving = true; scope.disabled = apply.disabled = true;
    const savedResource = resourceId;
    try { await onChange(scope.value as Settings['translationScope'], Number(seconds.value)); if (savedResource === resourceId) { dirty = false; localError = ''; } }
    catch (e) { if (savedResource === resourceId) { localError = e instanceof Error ? e.message : '设置未保存'; bindLocalizedText(note, () => localizeMessage(localError)); note.hidden = false; } }
    finally { saving = false; scope.disabled = apply.disabled = false; }
  }
  scope.addEventListener('change', () => { $('window-row').hidden = scope.value === 'all'; void save(); });
  seconds.addEventListener('input', () => { dirty = true; });
  apply.addEventListener('click', () => { void save(); });
  $('retry').addEventListener('click', onRetry);
  for (const event of ['click', 'dblclick', 'pointerdown', 'pointerup', 'keydown', 'keyup']) host.addEventListener(event, e => e.stopPropagation());
  root.addEventListener('keydown', e => { if ((e as KeyboardEvent).key === 'Escape') { details.open = false; root.querySelector('summary')!.focus(); } });
  return {
    renderPreviewHost, nativeSupplyHost,
    nativeSupplyButton,
    updateNativeSupply(view: NativeSupplyProgressView) {
      nativeSupplyHost.hidden = !view.visible;
      bindLocalizedText($('native-supply-title'), () => t(view.planned ? 'progress.supply.plannedTitle' : 'progress.supply.strictTitle'));
      bindLocalizedText($('native-supply-status'), () => t('progress.supply.state.' + view.state));
      bindLocalizedText($('native-supply-reason'), () => view.status);
      nativeSupplyButton.textContent = view.actionText;
      nativeSupplyButton.hidden = view.actionHidden;
      nativeSupplyButton.disabled = view.actionDisabled;
      const formatCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? formatNumber(value) : '—';
      for (const [id, value] of [
        ['supply-candidates', view.candidates], ['supply-selected', view.selected], ['supply-submitted', view.submitted],
        ['supply-cache-hits', view.cacheHits], ['supply-adopted', view.adopted], ['supply-skipped', view.skipped],
      ] as const) bindLocalizedText($(id), () => formatCount(value));
      const hybrid = view.hybrid;
      $('supply-metrics').hidden = !view.planned;
      const hybridDetails = $('hybrid-details');
      hybridDetails.hidden = !view.planned || !hybrid;
      const lane = (name: string) => hybrid?.[name] ?? {};
      const metric = (id: string, value: unknown) => bindLocalizedText($(id), () => formatCount(value));
      for (const [name, prefix] of [['local', 'hybrid-local'], ['online', 'hybrid-online']] as const) {
        const row = lane(name);
        metric(`${prefix}-requests`, row.actualRequests); metric(`${prefix}-items`, row.inputItems);
        metric(`${prefix}-chars`, row.inputChars); metric(`${prefix}-cache`, row.cacheHits);
        metric(`${prefix}-timely`, row.timelyQualified);
      }
      metric('hybrid-subscriptions', hybrid?.subscriptions); metric('hybrid-unique-tasks', hybrid?.uniqueTasks);
      metric('hybrid-merged-inputs', hybrid?.mergedInputs); metric('hybrid-expired', hybrid?.expired);
      visibility();
    },
    attach(session: string, nextResourceId: string, platform: 'niconico' | 'bilibili' = 'niconico') {
      if (nextResourceId && nextResourceId !== resourceId) {
        resourceId = nextResourceId; details.open = false; dirty = false; localError = '';
        userFilterView = null; displayPlan.update(null);
      }
      bilibili = platform === 'bilibili';
      const surface = [...document.querySelectorAll<HTMLElement>('[data-danlingo-player]')].find(el => el.dataset.danlingoPlayer === session);
      // PlayerPresenter contains the image and native action bar. Its parent is the page's player column.
      // A standalone in-flow native stage is also supported by the synthetic player contract.
      const candidate = surface?.closest<HTMLElement>(platform === 'bilibili' ? '#playerWrap, .player-wrap' : '.PlayerPresenter') ?? (surface?.querySelector('video') ? surface : null);
      const parent = candidate?.parentElement;
      const style = candidate && getComputedStyle(candidate), parentStyle = parent && getComputedStyle(parent);
      const flow = parentStyle && (['block', 'flow-root'].includes(parentStyle.display) || (parentStyle.display === 'flex' && parentStyle.flexDirection === 'column'));
      const nextAnchor = candidate && parent && candidate.querySelector('video') && flow && style && !['absolute','fixed'].includes(style.position) ? candidate : null;
      if (anchor !== nextAnchor) { resize.disconnect(); anchor = nextAnchor; if (anchor) resize.observe(anchor); }
      if (anchor) { if (anchor.nextElementSibling !== host) anchor.after(host); }
      else host.remove();
      visibility();
    },
    update(settings: Settings, stats: SchedulerStats, message: string, active: boolean, collectionComplete = true, nativeCounts: { translated: number; original: number } = { translated: 0, original: 0 }, nativeSupplyActive = false) {
      const visible = settings.enabled && settings.displayMode !== 'original' && active;
      const effective = stats.effectiveScope ?? (settings.translationScope === 'all' ? 'all' : 'window');
      const candidates = stats.candidates ?? stats.total;
      const filtered = stats.filtered ?? 0;
      const unknown = stats.eligibilityUnknown ?? 0;
      const scopeLabel = () => effective === 'all' ? t('m_b99a7b08598a') : t('m_6790822f5a71', { p0: settings.prefetchSeconds });
      bindLocalizedText($('progress-summary'), () => !stats.sourceComplete && !candidates ? t('m_e3181e5e7f9c') : t('progress.prepared', { prepared: stats.translated, eligible: stats.messages }));
      bindLocalizedAttribute(root.querySelector('summary')!, 'title', () => t('progress.scopeTitle', { scope: scopeLabel(), failed: stats.failed }));
      const progress = root.querySelector('progress')!; progress.max = Math.max(1, stats.messages); progress.value = stats.translated;
      bindLocalizedText($('near-progress'), () => t('m_a61f4a34a5de', { p0: settings.urgentSeconds, p1: stats.nearPrepared, p2: stats.nearTotal }));
      bindLocalizedText($('coverage'), () => t('progress.coverage', { candidates, range: stats.total, eligible: stats.messages, pending: !stats.sourceComplete || !collectionComplete ? t('progress.loading') : '' }));
      const skipped = stats.skipped;
      const skippedTotal = skipped.special + skipped.language + skipped.emoticon;
      bindLocalizedText($('filtered'), () => t('progress.filtered', { filtered, unknown }));
      $('filtered').hidden = !filtered && !unknown;
      bindLocalizedText($('skipped'), () => t('m_bb257ef11851', { p0: skippedTotal, p1: [skipped.language && t('m_83e9cf1eebe9', { p0: skipped.language }), skipped.special && t('m_00ad5128d465', { p0: skipped.special }), skipped.emoticon && t('m_436657d085b8', { p0: skipped.emoticon })].filter(Boolean).join(' · ') }));
      $('skipped').hidden = !skippedTotal;
      bindLocalizedText($('native-stage'), () => t('progress.nativeStage', { translated: nativeCounts.translated, original: nativeCounts.original }));
      bindLocalizedText($('scope-state'), () => stats.displayState === 'hidden' ? t('progress.hidden') : settings.translationScope === 'auto'
        ? effective === 'window' ? t('progress.autoWindow') : t('progress.autoAll') : t('progress.explicitScope', { scope: scopeLabel() }));
      if (!saving) { scope.value = settings.translationScope; if (!dirty) seconds.value = String(settings.prefetchSeconds); }
      scope.parentElement!.hidden = nativeSupplyActive;
      $('window-row').hidden = nativeSupplyActive || scope.value === 'all';
      bindLocalizedText(note, () => localizeMessage(localError || message) || (stats.failed ? t('m_a0fb964ae018', { p0: stats.failed }) : '')); note.hidden = !note.textContent;
      $('retry').hidden = nativeSupplyActive || !stats.failed;
      setActive(visible);
    },
    updateUserFilters(view: UserFilterStatusView | null) {
      userFilterView = bilibili && (!view?.resourceId || view.resourceId === resourceId) ? view : null;
      if (userFilterView) userFilterStatus.update(userFilterView);
      visibility();
    },
    updateDisplayPlan(view: DisplayPlanView | null) {
      displayPlan.update(bilibili && view?.resourceId === resourceId ? view : null);
      visibility();
    },
    dispose() { resize.disconnect(); document.removeEventListener('fullscreenchange', visibility); userFilterStatus.dispose(); displayPlan.dispose(); void localeReady.then(disposeLocale => disposeLocale()); host.remove(); },
  };

  function setActive(value: boolean) { active = value; visibility(); }
}
