import { formatNumber, getLocale, onLocaleChange } from '../i18n/text.ts';

export interface DisplayPlanView {
  enabled: boolean;
  connected: boolean;
  resourceId: string;
  status: string;
  parameters: { lookaheadMs: number; freezeMs: number; bucketMs: number; limit: number | null };
  frozenBuckets: number;
  selected: number;
  translationNeeded: number;
  unknown: number;
  truncated?: boolean;
  stopReason?: string;
  upcoming: { id: string; mediaTimeMs: number; originalText: string; unknown: boolean; needsTranslation: boolean }[];
  reasons?: Record<string, number>;
  error?: string;
}

const en = {
  title: 'Display list planning (preview only)', disconnected: 'Video disconnected', off: 'Off',
  waiting: 'Waiting for a current plan', ready: 'Preview ready', paused: 'Planning paused',
  invalid: 'Rule snapshot unavailable', stopped: 'Planning stopped', stoppedCleanup: 'Stopped after cleanup',
  stoppedInvalidated: 'Stopped because the video context changed', truncated: 'Records truncated; counts may be incomplete',
  failed: 'Could not read preview status', unknownStatus: 'Status unconfirmed',
  notice: 'Preview of DanLingo’s proposed display list only. Native display is unchanged; no translation model is called. Some user rules are not covered, so this list is not the final native admission result.',
  resource: 'Video', unverifiedResource: 'Video identity unavailable',
  parameters: 'Lookahead {lookahead} video s · freeze {freeze} video s ahead · bucket {bucket} video s · limit {limit}/bucket',
  unlimited: 'none', counts: 'Current epoch frozen buckets {buckets} · total proposed {selected} · pending due needing translation {translation} · pending due with unknown rule coverage {unknown}',
  upcoming: 'Upcoming proposed items', noUpcoming: 'No upcoming proposed items',
  unknownRule: 'Rule coverage unknown', needTranslation: 'Needs simulated translation',
  noTranslation: 'No translation needed', atTime: '{time} video s',
  userExcluded: 'User excluded', outOfScope: 'Outside scope', unsupportedType: 'Unsupported type',
  densityNotSelected: 'Density not selected', lateArrival: 'Late arrival', expired: 'Expired',
  snapshotInvalid: 'Snapshot invalid', outsideWindow: 'Outside time window',
  nativeFiltered: 'Native filtered', invalidCandidate: 'Invalid candidate', wrongResource: 'Wrong resource',
  conflictingCandidate: 'Conflicting candidate', draftDensity: 'Draft density not selected',
} as const;
const zh: Record<keyof typeof en, string> = {
  title: '显示名单规划（仅预览）', disconnected: '视频未连接', off: '已关闭',
  waiting: '等待当前名单', ready: '预览就绪', paused: '规划暂停', invalid: '规则快照不可用',
  stopped: '规划已停止', stoppedCleanup: '清理后已停止', stoppedInvalidated: '视频上下文变化，规划已停止',
  truncated: '记录已截断，计数可能不完整',
  failed: '预览状态读取失败', unknownStatus: '状态未确认',
  notice: '仅预览 DanLingo 拟选名单；不改变原生显示，不调用翻译模型。部分用户规则尚未覆盖，名单不是原生最终准入结果。',
  resource: '视频', unverifiedResource: '视频身份未确认',
  parameters: '前瞻 {lookahead} 视频秒 · 提前冻结 {freeze} 视频秒 · 时间桶 {bucket} 视频秒 · 每桶上限 {limit}',
  unlimited: '不限', counts: '当前 epoch 累计冻结桶 {buckets} · 累计拟选 {selected} · 待到期需译 {translation} · 待到期未知 {unknown}',
  upcoming: '即将到期条目', noUpcoming: '暂无即将到期条目',
  unknownRule: '规则覆盖未知', needTranslation: '需要模拟翻译', noTranslation: '无需翻译', atTime: '视频 {time} 秒',
  userExcluded: '用户排除', outOfScope: '范围外', unsupportedType: '类型不支持',
  densityNotSelected: '密度未选', lateArrival: '晚到', expired: '已过期',
  snapshotInvalid: '快照失效', outsideWindow: '时间窗外',
  nativeFiltered: '原生已过滤', invalidCandidate: '候选无效', wrongResource: '资源不符',
  conflictingCandidate: '候选冲突', draftDensity: '草稿密度未选',
};
type Label = keyof typeof en;
const label = (key: Label, values: Record<string, string | number> = {}) => {
  const dictionary = getLocale().startsWith('zh') ? zh : en;
  return dictionary[key].replace(/\{([a-z]+)\}/g, (match, name) =>
    values[name] === undefined ? match : String(values[name]));
};
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0
  ? formatNumber(value as number) : '—';
const seconds = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0
  ? new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 2 }).format(value / 1000) : '—';
const resource = (value: unknown) => {
  if (typeof value !== 'string') return label('unverifiedResource');
  const av = /^(av[1-9]\d{0,15}):(cid[1-9]\d{0,15})$/.exec(value);
  if (av) return `${av[1]} · ${av[2]}`;
  const bv = /^(BV[A-Za-z0-9]{10}):p([1-9]\d{0,4})$/.exec(value);
  return bv ? `${bv[1]} · P${bv[2]}` : label('unverifiedResource');
};
const reasonKeys: Record<string, Label> = {
  userExcluded: 'userExcluded', 'user-excluded': 'userExcluded',
  outOfScope: 'outOfScope', 'out-of-scope': 'outOfScope',
  unsupportedType: 'unsupportedType', 'unsupported-type': 'unsupportedType',
  densityNotSelected: 'densityNotSelected', 'density-not-selected': 'densityNotSelected',
  lateArrival: 'lateArrival', 'late-arrival': 'lateArrival',
  expired: 'expired', snapshotInvalid: 'snapshotInvalid', 'snapshot-invalid': 'snapshotInvalid',
  outsideWindow: 'outsideWindow', nativeFiltered: 'nativeFiltered',
  invalidCandidate: 'invalidCandidate', wrongResource: 'wrongResource',
  conflictingCandidate: 'conflictingCandidate', draftDensity: 'draftDensity',
};
const stopReasonKeys = new Map<string, Label>([
  ['cleanup', 'stoppedCleanup'], ['invalidated', 'stoppedInvalidated'],
]);

/** The summary deliberately never contains originalText or source IDs. */
export function displayPlanText(view: DisplayPlanView | null) {
  const enabled = !!view?.connected && view.enabled;
  const current = enabled && !view?.error && !['stopped', 'stale', 'invalid', 'snapshot-invalid'].includes(view.status) ? view : null;
  const state: Label = view?.status === 'stopped' ? stopReasonKeys.get(view.stopReason ?? '') ?? 'stopped'
    : !view?.connected ? 'disconnected' : !view.enabled ? 'off' : view.error ? 'failed'
    : ['preview', 'ready', 'running', 'active'].includes(view.status) ? 'ready'
      : ['waiting-transaction', 'waiting', 'idle', 'starting'].includes(view.status) ? 'waiting'
        : ['paused', 'stale'].includes(view.status) ? 'paused'
          : ['invalid', 'snapshot-invalid'].includes(view.status) ? 'invalid' : 'unknownStatus';
  const reasons = current?.reasons && typeof current.reasons === 'object'
    ? Object.entries(current.reasons).filter(([key, value]) => reasonKeys[key] && Number.isSafeInteger(value) && value >= 0)
      .map(([key, value]) => `${label(reasonKeys[key]!)} ${count(value)}`) : [];
  return {
    title: label('title'), state: label(state) + (view?.truncated === true && (current || view.status === 'stopped')
      ? ` · ${label('truncated')}` : ''), connected: !!view?.connected, enabled, hasData: !!current,
    resource: `${label('resource')} · ${resource(current?.resourceId)}`,
    parameters: current ? label('parameters', {
      lookahead: seconds(current.parameters?.lookaheadMs), freeze: seconds(current.parameters?.freezeMs),
      bucket: seconds(current.parameters?.bucketMs),
      limit: current.parameters?.limit === null ? label('unlimited') : count(current.parameters?.limit),
    }) : '',
    counts: current ? label('counts', { buckets: count(current.frozenBuckets), selected: count(current.selected),
      translation: count(current.translationNeeded), unknown: count(current.unknown) }) : '',
    reasons: reasons.join(' · '), notice: label('notice'), upcoming: label('upcoming'),
    noUpcoming: label('noUpcoming'), unknownRule: label('unknownRule'),
    needTranslation: label('needTranslation'), noTranslation: label('noTranslation'),
  };
}

export function mountDisplayPlan(host: HTMLElement, onToggle?: (enabled: boolean) => Promise<void>) {
  const style = document.createElement('style');
  style.textContent = `
    .display-plan{box-sizing:border-box;max-width:380px;min-width:0;padding:7px 10px;margin-top:6px;
      background:#f3f7f3;border:1px solid #d1ded4;border-radius:6px;color:#243f30;
      font:12px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;overflow-wrap:anywhere}
    .display-plan *{box-sizing:border-box}.display-plan [hidden]{display:none!important}
    .display-plan__toggle{display:flex;align-items:center;gap:7px;min-width:0;cursor:pointer;font-weight:600}
    .display-plan__toggle input{width:14px;height:14px;flex:none;margin:0;accent-color:#3b8153}
    .display-plan__toggle input:focus-visible,.display-plan summary:focus-visible{outline:2px solid #4b9468;outline-offset:2px}
    .display-plan__state{font-size:11px;color:#597361;margin:3px 0 0}
    .display-plan__body{display:grid;gap:5px;margin-top:6px;padding-top:6px;border-top:1px solid #d1ded4}
    .display-plan__body p{margin:0}.display-plan__meta,.display-plan__reasons{font-size:11px;color:#597361}
    .display-plan__notice{font-size:11px;color:#755b34}
    .display-plan details{font-size:11px}.display-plan summary{cursor:pointer;width:fit-content}
    .display-plan ol{margin:5px 0 0;padding-inline-start:20px;display:grid;gap:5px}
    .display-plan li{overflow-wrap:anywhere}.display-plan__time{color:#597361}
  `;
  const panel = document.createElement('section'); panel.className = 'display-plan';
  const toggleLabel = document.createElement('label'); toggleLabel.className = 'display-plan__toggle';
  const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
  const title = document.createElement('span'); toggleLabel.append(checkbox, title);
  const state = document.createElement('p'); state.className = 'display-plan__state'; state.setAttribute('role', 'status');
  const body = document.createElement('div'); body.className = 'display-plan__body';
  const source = document.createElement('p'), parameters = document.createElement('p'), counts = document.createElement('p');
  const reasons = document.createElement('p'), notice = document.createElement('p');
  source.className = parameters.className = counts.className = reasons.className = 'display-plan__meta';
  notice.className = 'display-plan__notice';
  const details = document.createElement('details'), detailsTitle = document.createElement('summary');
  const list = document.createElement('ol'); details.append(detailsTitle, list);
  body.append(source, parameters, counts, reasons, notice, details);
  panel.append(toggleLabel, state, body); host.append(style, panel);
  let view: DisplayPlanView | null = null;
  let pending = false;
  let pendingDesired: boolean | null = null;
  let toggleFailed = false;
  const clearItems = () => { details.open = false; list.replaceChildren(); };
  const renderItems = () => {
    list.replaceChildren();
    if (!details.open || !displayPlanText(view).hasData || !view) return;
    const items = Array.isArray(view.upcoming) ? view.upcoming.slice(0, 8) : [];
    for (const item of items) {
      if (!item || typeof item.originalText !== 'string' || item.originalText.length > 1000) continue;
      const line = document.createElement('li'), time = document.createElement('span'), text = document.createElement('span');
      time.className = 'display-plan__time';
      time.textContent = `${label('atTime', { time: seconds(item.mediaTimeMs) })} · `;
      text.textContent = item.originalText;
      const flags = document.createElement('span'); flags.className = 'display-plan__time';
      flags.textContent = ` · ${item.unknown ? label('unknownRule') + ' · ' : ''}${item.needsTranslation ? label('needTranslation') : label('noTranslation')}`;
      line.append(time, text, flags); list.append(line);
    }
    if (!list.childElementCount) {
      const empty = document.createElement('li'); empty.textContent = label('noUpcoming'); list.append(empty);
    }
  };
  const render = () => {
    const value = displayPlanText(view);
    title.textContent = value.title; checkbox.checked = pendingDesired ?? value.enabled;
    checkbox.disabled = pending || !onToggle || !value.connected;
    state.textContent = toggleFailed ? label('failed') : value.state;
    body.hidden = !value.hasData || pendingDesired === false;
    if (body.hidden) clearItems();
    source.textContent = value.resource; parameters.textContent = value.parameters; counts.textContent = value.counts;
    reasons.textContent = value.reasons; reasons.hidden = !value.reasons;
    notice.textContent = value.notice; detailsTitle.textContent = value.upcoming;
    renderItems();
  };
  const toggle = async () => {
    if (!onToggle || !view?.connected || pending) { render(); return; }
    const before = view, next = checkbox.checked;
    pending = true; pendingDesired = next; toggleFailed = false;
    if (!next) clearItems();
    render();
    try {
      await onToggle(next);
      if (view === before) view = { ...before, enabled: next, status: 'waiting',
        frozenBuckets: 0, selected: 0, translationNeeded: 0, unknown: 0, upcoming: [], reasons: {} };
    } catch { if (view === before) toggleFailed = true; }
    finally { pending = false; pendingDesired = null; render(); }
  };
  checkbox.addEventListener('change', () => { void toggle(); });
  details.addEventListener('toggle', () => { if (details.open) renderItems(); else list.replaceChildren(); });
  const unsubscribe = onLocaleChange(render); render();
  return {
    update(next: DisplayPlanView | null) { view = next; toggleFailed = false; render(); },
    dispose() { unsubscribe(); style.remove(); panel.remove(); },
  };
}
