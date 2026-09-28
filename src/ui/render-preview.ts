import { RenderPreviewEngine, type RenderPreviewLayout, type RenderPreviewTranslation,
  type RenderPreviewItem, type RenderPreviewMode } from '../core/render-preview.ts';
import type { DisplayPlanEvent } from '../core/display-plan.ts';
import { formatNumber, getLocale, onLocaleChange } from '../i18n/text.ts';

export interface RenderPreviewClock {
  resourceId: string; epoch: number; mediaTimeMs: number;
  paused?: boolean; seeking?: boolean; contentActive?: boolean;
}
export type RenderPreviewEvent = DisplayPlanEvent;
export type RenderEndReason = 'oversize' | 'text-unsupported' | 'layout-rejected';
export type RenderPreviewUiMode = RenderPreviewMode | 'live-local';
export interface RenderPreviewLiveIdentity { runId: string; configIdentity: string }
export type RenderExistingTranslation = RenderPreviewTranslation & (
  { origin: 'existing-cache' | 'export' } |
  { origin: 'live-local'; runId: string; requestId: string; resultId: string;
    configIdentity: string; availableAtMediaMs: number });
export interface RenderPreviewLiveState {
  status: 'unprepared' | 'ready' | 'running' | 'paused' | 'draining' | 'stopped' | 'error';
  modelName: string | null; modelState: string; targetLanguage: string;
  remaining: { requests: number; items: number; chars: number };
  sent: number; ready: number; adopted: number; fallback: number; reason: string | null;
}
export interface RenderPreviewFeed {
  resourceId: string; epoch: number; contextValid: boolean; targetLanguage: string;
  events: readonly RenderPreviewEvent[];
  eligibilityById?: Readonly<Record<string, 'exclude' | 'retain' | 'unknown'>>;
  existingTranslations?: readonly RenderExistingTranslation[];
  liveIdentity?: RenderPreviewLiveIdentity;
}
export interface RenderPreviewOptions {
  getClock: () => RenderPreviewClock | null;
  onToggle?: (enabled: boolean) => Promise<void> | void;
  onVisibilityChange?: (visible: boolean, reason: string | null) => void;
  onEarlyReject?: (event: RenderPreviewEvent, reason: RenderEndReason) => void;
  onLiveAction?: (action: 'start' | 'stop') => Promise<void> | void;
  onModeChange?: (mode: RenderPreviewUiMode) => void;
}

const FONT_SIZE = 20, LINE_HEIGHT = 28, PADDING_X = 6, PADDING_Y = 2, GAP = 16;
const MAX_TRANSLATIONS = 512, MAX_SPENT = 4096, MAX_DOM_SAMPLES = 1536, MAX_GEOMETRY = 512;
const keyOf = (row: Pick<DisplayPlanEvent, 'resourceId' | 'epoch' | 'id'>) =>
  JSON.stringify([row.resourceId, row.epoch, row.id]);
const validClock = (value: RenderPreviewClock | null): value is RenderPreviewClock => !!value &&
  !!value.resourceId && Number.isSafeInteger(value.epoch) && value.epoch >= 0 &&
  Number.isFinite(value.mediaTimeMs) && value.mediaTimeMs >= 0;

type ReportRecord = ReturnType<RenderPreviewEngine['report']>['records'][number];
export function renderPreviewScopedCounts(records: readonly ReportRecord[], resourceId: string, epoch: number) {
  const scoped = records.filter(row => row.resourceId === resourceId && row.epoch === epoch);
  return { proposed: scoped.length, reserved: scoped.filter(row => row.state === 'reserved').length,
    entered: scoped.filter(row => row.chosenAtMediaMs !== null).length,
    sampled: scoped.filter(row => row.visibleSamples > 0).length,
    rejected: scoped.filter(row => ['oversize', 'text-unsupported', 'layout-rejected'].includes(row.state)).length,
    unknown: scoped.filter(row => row.unknown).length };
}
export function renderTranslationAllowed(value: RenderExistingTranslation, resourceId: string,
  epoch: number, targetLanguage: string, liveIdentity?: RenderPreviewLiveIdentity) {
  const trusted = value?.origin === 'existing-cache' || value?.origin === 'export';
  const live = value?.origin === 'live-local' && !!liveIdentity?.runId && !!liveIdentity.configIdentity &&
    value.runId === liveIdentity.runId && value.configIdentity === liveIdentity.configIdentity &&
    typeof value.requestId === 'string' && !!value.requestId &&
    typeof value.resultId === 'string' && !!value.resultId &&
    Number.isFinite(value.availableAtMediaMs) && value.availableAtMediaMs >= 0;
  return !!value && (trusted || live) &&
    value.resourceId === resourceId && value.epoch === epoch && value.targetLanguage === targetLanguage &&
    typeof value.id === 'string' && !!value.id && typeof value.sourceId === 'string' && !!value.sourceId &&
    typeof value.originalText === 'string' && typeof value.text === 'string' && !!value.text &&
    Number.isFinite(value.availableAtWallMs) && value.availableAtWallMs >= 0;
}

/** DOM adapter for the isolated B-plan engine; live actions require an explicit host callback. */
export function mountRenderPreview(host: HTMLElement, options: RenderPreviewOptions) {
  const { getClock, onToggle, onVisibilityChange, onEarlyReject, onLiveAction, onModeChange } = options;
  const style = document.createElement('style');
  style.textContent = `
    .render-preview{box-sizing:border-box;width:100%;max-width:100%;min-width:0;margin-top:6px;padding:9px 10px;
      color:#243f30;background:#f3f7f3;border:1px solid #d1ded4;border-radius:7px;
      font:12px/1.5 "Segoe UI","Microsoft YaHei",sans-serif}
    .render-preview *{box-sizing:border-box}.render-preview [hidden]{display:none!important}
    .render-preview__toggle{display:flex;align-items:center;gap:8px;font-weight:600;cursor:pointer}
    .render-preview__toggle input{width:15px;height:15px;margin:0;accent-color:#3b8153}
    .render-preview__toggle input:focus-visible,.render-preview summary:focus-visible,
    .render-preview select:focus-visible,.render-preview button:focus-visible{outline:2px solid #4b9468;outline-offset:2px}
    .render-preview__body{min-width:0;margin-top:7px;border-top:1px solid #d1ded4;padding-top:7px}
    .render-preview__meta,.render-preview__counts,.render-preview__notice,.render-preview__reason{margin:0 0 5px;overflow-wrap:anywhere}
    .render-preview__meta,.render-preview__counts,.render-preview__reason{font-size:11px;color:#526f5c}
    .render-preview__notice{font-size:11px;color:#755b34}
    .render-preview__controls{display:flex;gap:8px;align-items:center;margin:5px 0;flex-wrap:wrap}
    .render-preview__controls label{display:flex;gap:5px;align-items:center}
    .render-preview__controls button{font:inherit;color:inherit;background:#fff;border:1px solid #b8cbbd;
      border-radius:5px;padding:3px 7px;cursor:pointer}
    .render-preview__controls button:disabled{opacity:.55;cursor:default}
    .render-preview__live{font-size:11px;color:#526f5c;margin:0 0 5px;overflow-wrap:anywhere}
    .render-preview select{font:inherit;color:inherit;background:#fff;border:1px solid #b8cbbd;border-radius:5px;padding:3px 6px}
    .render-preview details{font-size:11px;max-width:100%}.render-preview summary{cursor:pointer;width:fit-content}
    .render-preview__stage{position:relative;width:100%;height:240px;overflow:hidden;contain:layout paint;
      border-radius:5px;border:1px solid #38564a;background:#152721;color:#f3fff7}
    .render-preview__item{position:absolute;top:0;left:0;display:block;width:max-content;height:max-content;
      padding:${PADDING_Y}px ${PADDING_X}px;white-space:pre;pointer-events:none;
      font:normal ${FONT_SIZE}px/${LINE_HEIGHT}px "Segoe UI","Microsoft YaHei",sans-serif;
      color:#f3fff7;text-shadow:0 1px 2px #000a;will-change:transform}
    .render-preview__item--unknown{color:#ffdf8e;box-shadow:inset 0 -3px #e3ad4f}
    .render-preview__measure{position:absolute;visibility:hidden;pointer-events:none;transform:none!important}
    @media(prefers-reduced-motion:reduce){.render-preview__item{text-shadow:none}}
  `;
  const panel = document.createElement('section'); panel.className = 'render-preview';
  const toggleLabel = document.createElement('label'); toggleLabel.className = 'render-preview__toggle';
  const toggle = document.createElement('input'); toggle.type = 'checkbox';
  const title = document.createElement('span'); toggleLabel.append(toggle, title);
  const body = document.createElement('div'); body.className = 'render-preview__body'; body.hidden = true;
  const meta = document.createElement('p'), counts = document.createElement('p'), notice = document.createElement('p');
  meta.className = 'render-preview__meta'; counts.className = 'render-preview__counts'; notice.className = 'render-preview__notice';
  const controls = document.createElement('div'); controls.className = 'render-preview__controls';
  const modeLabel = document.createElement('label'), modeCaption = document.createElement('span'), mode = document.createElement('select');
  for (const value of ['original', 'stored-translation', 'live-local'] as const) {
    const option = document.createElement('option'); option.value = value; mode.append(option);
  }
  modeLabel.append(modeCaption, mode); controls.append(modeLabel);
  const start = document.createElement('button'), stop = document.createElement('button');
  start.type = stop.type = 'button'; controls.append(start, stop);
  const liveInfo = document.createElement('p'); liveInfo.className = 'render-preview__live';
  const details = document.createElement('details'); details.open = true;
  const summary = document.createElement('summary');
  const stage = document.createElement('div'); stage.className = 'render-preview__stage'; stage.setAttribute('aria-hidden', 'true');
  details.append(summary, stage);
  const reasons = document.createElement('details'), reasonsSummary = document.createElement('summary'), reasonsText = document.createElement('p');
  reasonsText.className = 'render-preview__reason'; reasons.append(reasonsSummary, reasonsText);
  body.append(meta, counts, controls, liveInfo, notice, details, reasons);
  panel.append(toggleLabel, body); host.append(style, panel);

  let enabled = false, disposed = false, pendingToggle = false, inViewport = false, running = false;
  let pendingLiveAction: 'start' | 'stop' | null = null;
  let liveState: RenderPreviewLiveState = { status: 'unprepared', modelName: null, modelState: 'unprepared',
    targetLanguage: '', remaining: { requests: 0, items: 0, chars: 0 },
    sent: 0, ready: 0, adopted: 0, fallback: 0, reason: null };
  let engine: RenderPreviewEngine | null = null, lastReport: ReturnType<RenderPreviewEngine['report']> | null = null;
  let resourceId = '', epoch = -1, contextValid = false, targetLanguage = '';
  let raf = 0, lastSummaryAt = 0, lastSampleAt = 0, pendingFeed: RenderPreviewFeed | null = null;
  let meter: HTMLElement | null = null, intersection: IntersectionObserver | null = null, resize: ResizeObserver | null = null;
  let motion: MediaQueryList | null = null;
  let lifecycleListenersActive = false, fontListenerActive = false;
  const translations = new Map<string, RenderExistingTranslation>();
  const liveTranslations = new Map<string, RenderExistingTranslation>();
  let liveIdentity: RenderPreviewLiveIdentity | null = null;
  const nodes = new Map<string, HTMLElement>(), spent = new Set<string>();
  const domSamples: { key: string; mediaTimeMs: number; wallTimeMs: number; xPx: number; yPx: number;
    widthPx: number; heightPx: number; stageWidthPx: number; fontSizePx: number; lineHeightPx: number;
    sourceMode: RenderPreviewMode; origin: RenderPreviewTranslation['origin'] | null;
    runId: string | null; requestId: string | null; resultId: string | null; configIdentity: string | null }[] = [];
  const perKeySamples = new Map<string, number>();
  let domSampleCount = 0, domSampleTruncated = false;
  let spentCutoffMs = -1;
  const readClock = () => { try { const clock = getClock(); return validClock(clock) ? clock : null; } catch { return null; } };
  const advanceSpentCutoff = () => {
    const clock = readClock();
    if (clock?.resourceId === resourceId && clock.epoch === epoch)
      spentCutoffMs = Math.max(spentCutoffMs, clock.mediaTimeMs);
  };
  const dictionary = () => getLocale().startsWith('zh') ? {
    title: '渲染预览', mode: '文字来源', original: '原文', existing: '已有译文优先',
    live: '真实本地翻译', start: '启动', stop: '停止', area: '预览区域',
    reason: '原因与范围', notice: '这是独立渲染测试，不改变原生弹幕。拟选内容可能仍含未覆盖的屏蔽规则，不代表已通过 Bilibili 全部筛选。不会调用翻译模型。黄色下划线表示规则覆盖未知。',
    liveNotice: '只在明确启动后使用当前本地模型，受剩余预算限制；不调用在线模型，不改变原生弹幕。拟选内容可能仍含未覆盖的屏蔽规则，黄色下划线表示规则覆盖未知。',
    liveStatus: { unprepared: '未准备', ready: '已就绪', running: '运行中', paused: '已暂停',
      draining: '停止新需求，等待画面退出', stopped: '已停止', error: '错误' },
    prepareRequired: '先完成本地实验准备并绑定本页，再启动。',
    waiting: '等待当前 B 名单', paused: '预览暂停，恢复后仅接收未来条目', invalid: '规则上下文不可用',
    active: '预览运行中', reduced: '系统减少动态效果，预览运动暂停',
  } : {
    title: 'Render preview', mode: 'Text source', original: 'Original', existing: 'Existing translation first',
    live: 'Real local translation', start: 'Start', stop: 'Stop', area: 'Preview area',
    reason: 'Reasons and scope', notice: 'This independent test does not change native danmaku. Proposed items may contain uncovered user rules and are not final Bilibili admission. No translation model is called. Amber underline means rule coverage unknown.',
    liveNotice: 'Only an explicit start uses the selected local model within the remaining budget. No online model or native danmaku is changed. Proposed items may include uncovered user rules; amber underline marks unknown coverage.',
    liveStatus: { unprepared: 'Unprepared', ready: 'Ready', running: 'Running', paused: 'Paused',
      draining: 'No new demand; waiting for display to clear', stopped: 'Stopped', error: 'Error' },
    prepareRequired: 'Prepare the local experiment and bind this page before starting.',
    waiting: 'Waiting for the current B plan', paused: 'Preview paused; only future items resume', invalid: 'Rule context unavailable',
    active: 'Preview running', reduced: 'Reduced motion is enabled; preview movement is paused',
  };
  const reason = (): string | null => !enabled ? 'disabled' : disposed ? 'disposed'
    : !contextValid ? 'rule-context-invalid' : document.visibilityState === 'hidden' ? 'tab-hidden'
      : !!document.fullscreenElement || !!document.pictureInPictureElement ? 'fullscreen-or-pip'
        : !!motion?.matches ? 'reduced-motion' : !details.open ? 'collapsed'
          : !panel.isConnected || !panel.getClientRects().length ? 'detached'
            : !inViewport ? 'outside-viewport' : null;
  const visible = () => reason() === null;
  const updateText = () => {
    const s = dictionary(), clock = readClock(), snapshot = engine?.report() ?? lastReport;
    const values = snapshot?.counts;
    const scoped = renderPreviewScopedCounts(snapshot?.records ?? [], resourceId, epoch);
    title.textContent = s.title; modeCaption.textContent = s.mode;
    mode.options[0]!.textContent = s.original; mode.options[1]!.textContent = s.existing;
    mode.options[2]!.textContent = s.live; start.textContent = s.start; stop.textContent = s.stop;
    const liveSelected = mode.value === 'live-local';
    start.hidden = stop.hidden = liveInfo.hidden = !liveSelected;
    const budget = liveState.remaining;
    start.disabled = !onLiveAction || !!pendingLiveAction || liveState.status !== 'ready' ||
      budget.requests <= 0 || budget.items <= 0 || budget.chars <= 0;
    stop.disabled = !onLiveAction || !!pendingLiveAction || !['running', 'paused'].includes(liveState.status);
    const liveReason = ['live-preview-invalid-owner', 'live-preview-prepare-required'].includes(liveState.reason ?? '')
      ? s.prepareRequired : liveState.reason;
    liveInfo.textContent = getLocale().startsWith('zh')
      ? `${s.liveStatus[liveState.status]} · 模型 ${liveState.modelName ?? '—'} (${liveState.modelState}) · 目标 ${liveState.targetLanguage || '—'} · 剩余 请求 ${formatNumber(budget.requests)}/条目 ${formatNumber(budget.items)}/字 ${formatNumber(budget.chars)} · 已发送 ${formatNumber(liveState.sent)}/就绪 ${formatNumber(liveState.ready)}/采用 ${formatNumber(liveState.adopted)}/原文回退 ${formatNumber(liveState.fallback)}${liveReason ? ` · ${liveReason}` : ''}`
      : `${s.liveStatus[liveState.status]} · Model ${liveState.modelName ?? '—'} (${liveState.modelState}) · Target ${liveState.targetLanguage || '—'} · Remaining requests ${formatNumber(budget.requests)}/items ${formatNumber(budget.items)}/chars ${formatNumber(budget.chars)} · Sent ${formatNumber(liveState.sent)}/ready ${formatNumber(liveState.ready)}/adopted ${formatNumber(liveState.adopted)}/fallback ${formatNumber(liveState.fallback)}${liveReason ? ` · ${liveReason}` : ''}`;
    summary.textContent = s.area; reasonsSummary.textContent = s.reason;
    notice.textContent = liveSelected ? s.liveNotice : s.notice;
    toggle.checked = enabled; toggle.disabled = pendingToggle; body.hidden = !enabled;
    const time = clock && clock.resourceId === resourceId ? (clock.mediaTimeMs / 1000).toFixed(2) + 's' : '—';
    meta.textContent = `${resourceId || '—'} · ${time} · ${!contextValid ? s.invalid : reason() === 'reduced-motion' ? s.reduced : running ? s.active : s.paused}`;
    counts.textContent = getLocale().startsWith('zh')
      ? `拟选 ${formatNumber(scoped.proposed)} · 预约 ${formatNumber(scoped.reserved)} · 进入 ${formatNumber(scoped.entered)} · 采样可见 ${formatNumber(scoped.sampled)} · 拒绝 ${formatNumber(scoped.rejected)} · 未知 ${formatNumber(scoped.unknown)}`
      : `Proposed ${formatNumber(scoped.proposed)} · reserved ${formatNumber(scoped.reserved)} · entered ${formatNumber(scoped.entered)} · sampled visible ${formatNumber(scoped.sampled)} · rejected ${formatNumber(scoped.rejected)} · unknown ${formatNumber(scoped.unknown)}`;
    reasonsText.textContent = Object.entries(values ?? {}).filter(([key, count]) => count > 0 &&
      !['selected', 'reserved', 'committed', 'visibleDistinct', 'unknown'].includes(key))
      .map(([key, count]) => `${key}: ${formatNumber(count)}`).join(' · ') || '—';
  };
  const clearNodes = () => { for (const node of nodes.values()) node.remove(); nodes.clear(); };
  const ensureMeter = () => {
    if (meter) return meter;
    meter = document.createElement('div'); meter.className = 'render-preview__item render-preview__measure';
    stage.append(meter); return meter;
  };
  const layout = (): RenderPreviewLayout | null => {
    const widthPx = stage.clientWidth, heightPx = stage.clientHeight;
    return widthPx > GAP && heightPx > LINE_HEIGHT ? { widthPx, heightPx, fontSizePx: FONT_SIZE,
      lineHeightPx: LINE_HEIGHT, paddingXPx: PADDING_X, paddingYPx: PADDING_Y, gapPx: GAP, safetyPx: 2 } : null;
  };
  const createEngine = (language: string) => {
    domSamples.length = 0; domSampleCount = 0; domSampleTruncated = false;
    perKeySamples.clear(); lastSampleAt = 0;
    engine = new RenderPreviewEngine({ mode: 'original', targetLanguage: language,
      measure: text => {
        const node = ensureMeter(); node.textContent = text;
        const rect = node.getBoundingClientRect();
        return { widthPx: rect.width, heightPx: rect.height, lines: 1 };
      },
      resolveTranslation: event => mode.value === 'live-local'
        ? liveTranslations.get(keyOf(event)) : translations.get(keyOf(event)),
      onEarlyReject: (event, why) => onEarlyReject?.(event, why),
    });
    const clock = readClock();
    if (clock && !visible()) engine.setVisible(false, clock.mediaTimeMs);
  };
  const ensureEngine = (language: string) => {
    if (engine && targetLanguage === language) return;
    if (engine) { advanceSpentCutoff(); engine.close(readClock()?.mediaTimeMs ?? 0); lastReport = engine.report(); clearNodes(); }
    translations.clear(); liveTranslations.clear(); targetLanguage = language; createEngine(language);
  };
  const paint = (items: readonly RenderPreviewItem[]) => {
    const active = new Set(items.map(item => item.key));
    for (const [key, node] of nodes) if (!active.has(key)) { node.remove(); nodes.delete(key); }
    for (const item of items) {
      let node = nodes.get(item.key);
      if (!node) {
        node = document.createElement('div'); node.className = 'render-preview__item';
        node.classList.toggle('render-preview__item--unknown', item.unknown);
        node.dataset.renderKey = item.key; node.dataset.renderLane = String(item.lane);
        node.dataset.renderRevision = String(item.layoutRevision);
        node.dataset.textSource = item.sourceMode;
        node.dataset.renderOrigin = item.origin ?? '';
        node.dataset.renderRunId = item.runId ?? '';
        node.dataset.renderRequestId = item.requestId ?? '';
        node.dataset.renderResultId = item.resultId ?? '';
        node.dataset.renderConfigIdentity = item.configIdentity ?? '';
        node.textContent = item.text; stage.append(node); nodes.set(item.key, node);
      }
      node.style.transform = `translate3d(${item.xPx}px,${item.yPx}px,0)`;
    }
  };
  const stopLoop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
  const loop = () => {
    raf = 0;
    if (!enabled || !engine || !visible()) return;
    const clock = readClock();
    if (!clock || clock.resourceId !== resourceId || clock.epoch !== epoch || clock.contentActive === false) {
      clearNodes(); engine.setVisible(false, clock?.mediaTimeMs ?? 0); running = false;
      onVisibilityChange?.(false, 'clock-invalid'); updateText(); return;
    }
    const wallTimeMs = performance.now();
    const tick = engine.tick({ mediaTimeMs: clock.mediaTimeMs, wallTimeMs, paused: clock.paused, seeking: clock.seeking });
    paint(tick.active);
    // Keep the 35-second bounded run within the sample ledger even at maximum occupancy.
    if (wallTimeMs - lastSampleAt >= 500 && tick.active.length) {
      const box = stage.getBoundingClientRect(), keys: string[] = [];
      const stageStyle = getComputedStyle(stage);
      for (const [key, node] of nodes) {
        if (domSampleCount + keys.length >= MAX_DOM_SAMPLES) { domSampleTruncated = true; break; }
        const rect = node.getBoundingClientRect();
        const itemStyle = getComputedStyle(node);
        if (stageStyle.visibility !== 'hidden' && stageStyle.display !== 'none' && Number(stageStyle.opacity) > 0 &&
            itemStyle.visibility !== 'hidden' && itemStyle.display !== 'none' && Number(itemStyle.opacity) > 0 &&
            rect.left < box.right && rect.right > box.left && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1) {
          keys.push(key);
          if (domSamples.length < MAX_GEOMETRY && (perKeySamples.get(key) ?? 0) < 12) {
            domSamples.push({ key, mediaTimeMs: clock.mediaTimeMs, wallTimeMs,
              xPx: rect.left - box.left, yPx: rect.top - box.top, widthPx: rect.width,
              heightPx: rect.height, stageWidthPx: box.width, fontSizePx: parseFloat(itemStyle.fontSize),
              lineHeightPx: parseFloat(itemStyle.lineHeight),
              sourceMode: node.dataset.textSource as RenderPreviewMode,
              origin: node.dataset.renderOrigin as RenderPreviewTranslation['origin'] || null,
              runId: node.dataset.renderRunId || null, requestId: node.dataset.renderRequestId || null,
              resultId: node.dataset.renderResultId || null,
              configIdentity: node.dataset.renderConfigIdentity || null });
            perKeySamples.set(key, (perKeySamples.get(key) ?? 0) + 1);
          }
        }
      }
      engine.sampleVisible(keys, clock.mediaTimeMs, wallTimeMs);
      domSampleCount += keys.length; lastSampleAt = wallTimeMs;
    }
    if (wallTimeMs - lastSummaryAt >= 500) { lastSummaryAt = wallTimeMs; updateText(); }
    raf = requestAnimationFrame(loop);
  };
  const reconcile = () => {
    const shouldRun = visible() && !!engine;
    if (!shouldRun) {
      stopLoop(); clearNodes();
      if (running) {
        running = false; engine?.setVisible(false, readClock()?.mediaTimeMs ?? 0);
        onVisibilityChange?.(false, reason()); updateText();
      }
      return;
    }
    if (!running) {
      running = true; engine!.setVisible(true, readClock()?.mediaTimeMs ?? 0);
      onVisibilityChange?.(true, null); updateText();
    }
    if (!raf) raf = requestAnimationFrame(loop);
  };
  const onVisibility = () => reconcile();
  const onResize = () => {
    if (!enabled || !engine) return;
    const next = layout(), clock = readClock();
    if (!next || !clock) { reconcile(); return; }
    engine.setLayout(next, clock.mediaTimeMs); clearNodes(); reconcile();
  };
  const listen = () => {
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('fullscreenchange', onVisibility);
    document.addEventListener('enterpictureinpicture', onVisibility, true);
    document.addEventListener('leavepictureinpicture', onVisibility, true);
    details.addEventListener('toggle', onVisibility);
    lifecycleListenersActive = true;
    if (document.fonts?.addEventListener) {
      document.fonts.addEventListener('loadingdone', onResize); fontListenerActive = true;
    }
    intersection = new IntersectionObserver(entries => {
      inViewport = !!entries[0]?.isIntersecting && entries[0].intersectionRatio >= .25; reconcile();
    }, { threshold: [0, .25, 1] });
    intersection.observe(stage);
    resize = new ResizeObserver(onResize); resize.observe(stage);
    motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    motion.addEventListener('change', onVisibility);
  };
  const unlisten = () => {
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('fullscreenchange', onVisibility);
    document.removeEventListener('enterpictureinpicture', onVisibility, true);
    document.removeEventListener('leavepictureinpicture', onVisibility, true);
    details.removeEventListener('toggle', onVisibility);
    lifecycleListenersActive = false;
    if (fontListenerActive) document.fonts.removeEventListener('loadingdone', onResize);
    fontListenerActive = false;
    intersection?.disconnect(); intersection = null; resize?.disconnect(); resize = null;
    motion?.removeEventListener('change', onVisibility); motion = null; inViewport = false;
  };
  const setEnabled = (next: boolean) => {
    if (disposed || enabled === next) return;
    if (!next) {
      advanceSpentCutoff();
      enabled = false; stopLoop(); unlisten(); clearNodes();
      const before = engine?.report();
      if (before) for (const row of before.records) if (!['reserved', 'unallocated'].includes(row.state) &&
        spent.size < MAX_SPENT) spent.add(row.key);
      engine?.close(readClock()?.mediaTimeMs ?? 0); lastReport = engine?.report() ?? lastReport; engine = null;
      translations.clear(); liveTranslations.clear(); liveIdentity = null;
      meter?.remove(); meter = null; stage.replaceChildren();
      pendingFeed = null; contextValid = false; running = false;
      onVisibilityChange?.(false, 'disabled');
    } else {
      if (lastReport) advanceSpentCutoff();
      enabled = true; ensureMeter(); listen(); reconcile();
    }
    updateText();
  };
  const feed = (input: RenderPreviewFeed | null): string[] => {
    if (!enabled || disposed) return [];
    const clock = readClock();
    if (!input || !input.contextValid || !clock || clock.resourceId !== input.resourceId || clock.epoch !== input.epoch) {
      contextValid = false; pendingFeed = null;
      if (engine && resourceId && epoch >= 0) engine.sync({ resourceId, epoch,
        mediaTimeMs: clock?.mediaTimeMs ?? 0, events: [], contextValid: false });
      reconcile(); updateText(); return [];
    }
    if (resourceId !== input.resourceId || epoch !== input.epoch) {
      resourceId = input.resourceId; epoch = input.epoch; spent.clear(); spentCutoffMs = -1;
      translations.clear(); liveTranslations.clear(); liveIdentity = null; clearNodes();
    }
    contextValid = true;
    const nextLayout = layout();
    if (!nextLayout) { pendingFeed = input; reconcile(); return []; }
    pendingFeed = null;
    ensureEngine(input.targetLanguage);
    engine!.setLayout(nextLayout, clock.mediaTimeMs);
    const nextLiveIdentity = input.liveIdentity?.runId && input.liveIdentity.configIdentity
      ? input.liveIdentity : null;
    if (liveIdentity?.runId !== nextLiveIdentity?.runId ||
        liveIdentity?.configIdentity !== nextLiveIdentity?.configIdentity) {
      liveTranslations.clear(); liveIdentity = nextLiveIdentity;
    }
    const accepted: RenderExistingTranslation[] = [];
    for (const translation of input.existingTranslations ?? []) {
      if (!renderTranslationAllowed(translation, input.resourceId, input.epoch,
        input.targetLanguage, liveIdentity ?? undefined)) continue;
      const selectedMap = translation.origin === 'live-local' ? liveTranslations : translations;
      const key = keyOf(translation);
      if (!selectedMap.has(key) && selectedMap.size >= MAX_TRANSLATIONS)
        selectedMap.delete(selectedMap.keys().next().value!);
      if (!selectedMap.has(key) || selectedMap.get(key)?.availableAtWallMs !== translation.availableAtWallMs ||
          selectedMap.get(key)?.resultId !== translation.resultId) {
        selectedMap.set(key, { ...translation }); accepted.push(translation);
      }
    }
    engine!.setMode(mode.value !== 'original' && !!targetLanguage ? 'stored-translation' : 'original');
    const early = engine!.sync({ resourceId, epoch, mediaTimeMs: clock.mediaTimeMs, contextValid: true,
      events: input.events.filter(event => event.mediaTimeMs > spentCutoffMs && !spent.has(keyOf(event))),
      eligibility: event => Object.hasOwn(input.eligibilityById ?? {}, event.id)
        ? input.eligibilityById![event.id] ?? (event.unknown ? 'unknown' : 'retain')
        : event.unknown ? 'unknown' : 'retain' });
    for (const translation of accepted) if (mode.value === 'live-local'
      ? translation.origin === 'live-local' : mode.value === 'stored-translation' && translation.origin !== 'live-local')
      engine!.noteTranslationResult(translation);
    updateText(); reconcile(); return early;
  };
  const activeDomPositions = () => {
    const clock = readClock();
    if (!clock || clock.resourceId !== resourceId || clock.epoch !== epoch || !nodes.size) return [];
    const box = stage.getBoundingClientRect();
    return [...nodes].map(([key, node]) => {
      const rect = node.getBoundingClientRect();
      return { key, mediaTimeMs: clock.mediaTimeMs, xPx: rect.left - box.left,
        yPx: rect.top - box.top, widthPx: rect.width, heightPx: rect.height,
        sourceMode: node.dataset.textSource, origin: node.dataset.renderOrigin || null,
        runId: node.dataset.renderRunId || null, requestId: node.dataset.renderRequestId || null,
        resultId: node.dataset.renderResultId || null,
        configIdentity: node.dataset.renderConfigIdentity || null };
    });
  };
  const report = (includeText = false) => ({ ...(engine?.report(includeText) ?? lastReport ?? {
    contract: 'render-preview-v1', resourceId, epoch, counts: {}, records: [], samples: [], layouts: [] }),
    ui: { enabled, visible: visible(), suspendReason: reason(), activeNodes: nodes.size,
      rafActive: !!raf, intersectionActive: !!intersection, resizeActive: !!resize,
      measurementNodes: meter ? 1 : 0, mode: mode.value, textInReport: includeText,
      liveState: { ...liveState, remaining: { ...liveState.remaining } },
      visibilityListenerCount: lifecycleListenersActive ? 4 : 0,
      detailsListenerCount: lifecycleListenersActive ? 1 : 0,
      fontListenerCount: fontListenerActive ? 1 : 0,
      motionListenerCount: motion ? 1 : 0,
      domSampleCount, domSampleTruncated, sampleIntervalMs: 500, domSamples: domSamples.map(item => ({ ...item })),
      activeDomPositions: activeDomPositions(),
      offscreenPolicy: 'stop-and-resume-future-only' } });
  const cleanup = () => { setEnabled(false); resourceId = ''; epoch = -1;
    spent.clear(); spentCutoffMs = -1; updateText(); };
  const setMode = (next: RenderPreviewUiMode) => {
    if (!['original', 'stored-translation', 'live-local'].includes(next)) throw new RangeError('render-preview-mode-invalid');
    mode.value = next;
    engine?.setMode(next !== 'original' && !!targetLanguage ? 'stored-translation' : 'original');
    updateText();
  };
  const setLiveState = (next: RenderPreviewLiveState) => {
    liveState = { ...next, remaining: { ...next.remaining } };
    if (pendingLiveAction === 'start' && ['running', 'paused', 'error'].includes(next.status) ||
        pendingLiveAction === 'stop' && ['draining', 'stopped', 'error'].includes(next.status))
      pendingLiveAction = null;
    updateText();
  };
  mode.addEventListener('change', () => { const next = mode.value as RenderPreviewUiMode;
    setMode(next); onModeChange?.(next); });
  const liveAction = (action: 'start' | 'stop') => {
    if (pendingLiveAction || (action === 'start' ? start.disabled : stop.disabled)) return;
    pendingLiveAction = action; updateText();
    void Promise.resolve().then(() => onLiveAction?.(action)).catch(() => {
      pendingLiveAction = null;
      setLiveState({ ...liveState, status: 'error', reason: `${action}-failed` });
    });
  };
  start.addEventListener('click', () => liveAction('start'));
  stop.addEventListener('click', () => liveAction('stop'));
  toggle.addEventListener('change', () => {
    if (pendingToggle) return;
    const next = toggle.checked; pendingToggle = true; updateText();
    void Promise.resolve().then(() => onToggle?.(next)).then(() => setEnabled(next))
      .catch(() => { toggle.checked = enabled; })
      .finally(() => { pendingToggle = false; updateText(); });
  });
  const unsubscribe = onLocaleChange(updateText); updateText();
  return { feed, setEnabled, setMode, setLiveState, report, cleanup, suspendReason: reason, isVisible: visible,
    reveal() { panel.scrollIntoView({ block: 'nearest', inline: 'nearest' }); if (pendingFeed) feed(pendingFeed); reconcile(); },
    dispose() { if (disposed) return; cleanup(); disposed = true; unsubscribe(); panel.remove(); style.remove(); },
  };
}
