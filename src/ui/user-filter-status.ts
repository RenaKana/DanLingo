import { formatNumber, onLocaleChange, t } from '../i18n/text.ts';

export interface UserFilterStatusView {
  connected: boolean;
  stale: boolean;
  featureEnabled: boolean;
  resourceId?: string;
  tabId?: number;
  summary?: Record<string, any> | null;
  readFailed?: boolean;
}

const labels = [
  "title",
  "source",
  "tab",
  "selectTab",
  "chooseTab",
  "disconnected",
  "stale",
  "readFailed",
  "featureOff",
  "reading",
  "nativeOff",
  "nativeUnknown",
  "all",
  "partial",
  "unknown",
  "readComplete",
  "readPartial",
  "readUnknown",
  "keyword",
  "regexp",
  "sender",
  "account",
  "enabled",
  "supported",
  "unsupported",
  "degraded",
  "ready",
  "disabled",
  "partly",
  "unconfirmed",
  "count",
  "regexpCount",
  "accountUnknown",
  "samples",
  "sampleCounts",
  "samplesUnknown",
  "nativeBranch",
  "details",
  "noDetails",
  "omitted",
  "supportedRule",
  "unsupportedRule",
  "previous",
  "reasonUnknown",
  "reasonOther",
  "uncovered",
  "source-unavailable",
  "account-blacklist-is-not-danmaku-sender-list",
  "unsafe-or-invalid-regexp",
  "rule-size-limit",
  "pattern-size-limit",
  "invalid-native-regexp",
  "backreference",
  "lookaround",
  "group",
  "alternation",
  "quantifier",
  "unsupported-escape",
  "work-limit",
  "unsupported-flags",
  "unsupported-feature",
  "native-invalid",
  "nested-variable-repetition",
  "ambiguous-repeated-group",
  "zero-width-repetition",
  "repetition-size-limit",
  "syntax-complexity-limit",
  "group-depth-limit",
  "lookaround-or-named-group",
  "unsupported-character-class",
  "unsupported-quantifier-syntax"
] as const;
type Label = typeof labels[number];
const labelSet = new Set<string>(labels);
const label = (key: Label, values: Record<string, string | number> = {}) => t('userFilter.' + key, values);
const number = (value: unknown): string => Number.isSafeInteger(value) && (value as number) >= 0
  ? formatNumber(value as number) : '—';
const code = (value: unknown): string => typeof value === 'string' && /^[a-z][a-z0-9-]{0,80}$/.test(value) ? value : '';
const reason = (value: unknown): string => {
  const safe = code(value);
  if (!safe) return label('reasonUnknown');
  return label(labelSet.has(safe) ? safe as Label : 'reasonOther');
};

export function userFilterSourceLabel(resourceId?: string, tabId?: number): string {
  const match = /^av([1-9]\d{0,15}):cid([1-9]\d{0,15})$/.exec(resourceId ?? '');
  const video = match ? `av${match[1]} · cid${match[2]}` : label('source');
  return Number.isSafeInteger(tabId) && (tabId as number) >= 0
    ? `${video} · ${label('tab')} ${number(tabId)}` : video;
}

export function userFilterSourceSelectionText() {
  return { label: label('selectTab'), placeholder: label('chooseTab') };
}

export function userFilterStatusText(view: UserFilterStatusView) {
  const summary = view.summary;
  const categories = summary?.categories && typeof summary.categories === 'object' ? summary.categories : {};
  const declared = ['keyword', 'regexp', 'sender'].map(key => categories[key]);
  const nativeEnabled = summary?.nativeEnabled === true;
  const readComplete = summary?.readEvidence?.listComplete === true;
  const degraded = categories.regexp?.degraded;
  const suppressed = Array.isArray(summary?.suppressedCategories) && summary.suppressedCategories.length > 0;
  const allCovered = readComplete && nativeEnabled && degraded === 0 && !suppressed && declared.every(row =>
    row?.status === 'ready' && Number.isSafeInteger(row.enabled) && Number.isSafeInteger(row.supported)
    && row.supported >= row.enabled);
  const partlyCovered = suppressed || Number.isSafeInteger(degraded) && degraded > 0 || declared.some(row => row?.status === 'partial'
    || row?.status === 'ready' && Number.isSafeInteger(row.enabled) && Number.isSafeInteger(row.supported)
      && row.supported < row.enabled);
  const state = view.readFailed ? 'readFailed' : !view.connected ? 'disconnected' : view.stale ? 'stale'
    : !view.featureEnabled ? 'featureOff' : !summary ? 'reading' : summary.nativeEnabled === false ? 'nativeOff'
      : !nativeEnabled ? 'nativeUnknown' : allCovered ? 'all' : partlyCovered ? 'partial' : 'unknown';
  const read = !summary ? 'readUnknown' : readComplete ? 'readComplete'
    : summary.readEvidence?.listComplete === false ? 'readPartial' : 'readUnknown';
  const rowText = (key: 'keyword' | 'regexp' | 'sender' | 'account') => {
    if (key === 'account') return label('accountUnknown');
    const row = categories[key];
    const status: Label = row?.status === 'ready' ? 'ready' : row?.status === 'partial' ? 'partly'
      : row?.status === 'disabled' ? 'disabled' : 'unconfirmed';
    const metrics = key === 'regexp'
      ? label('regexpCount', { enabled: number(row?.enabled), supported: number(row?.supported),
        unsupported: nativeEnabled && Number.isSafeInteger(row?.enabled) && Number.isSafeInteger(row?.supported)
          ? number(Math.max(0, row.enabled - row.supported)) : '—', degraded: number(row?.degraded) })
      : label('count', { enabled: number(row?.enabled), supported: number(row?.supported) });
    return `${metrics} · ${label(status)}${code(row?.reason) ? ` · ${reason(row.reason)}` : ''}`;
  };
  const sampled = summary?.sampledHits;
  const sampledText = sampled && ['keyword', 'regexp', 'sender'].some(key => Number.isSafeInteger(sampled[key]))
    ? label('sampleCounts', { keyword: number(sampled.keyword), regexp: number(sampled.regexp), sender: number(sampled.sender) })
    : label('samplesUnknown');
  const nativeBranch = Number.isSafeInteger(summary?.natural?.matchedUserBranch)
    ? label('nativeBranch', { count: number(summary?.natural?.matchedUserBranch) }) : '';
  const regexp = categories.regexp;
  const entries = Array.isArray(regexp?.details) ? regexp.details.slice(0, 200) : [];
  const details: string[] = entries.map((entry: any) => {
    const id = typeof entry?.id === 'string' && /^R[1-9]\d{0,3}$/.test(entry.id) ? entry.id : 'R?';
    const status = entry?.supported === true ? label('supportedRule') : label('unsupportedRule');
    const explanation = code(entry?.reason) ? reason(entry.reason) : label('reasonUnknown');
    const previous = code(entry?.oldReason) ? ` · ${label('previous', { reason: reason(entry.oldReason) })}` : '';
    return `${id} · ${status} · ${explanation}${previous}`;
  });
  return {
    state: label(state), source: userFilterSourceLabel(view.resourceId, view.tabId), read: label(read),
    coverage: label(allCovered ? 'all' : partlyCovered ? 'partial' : 'unknown'),
    rows: (['keyword', 'regexp', 'sender', 'account'] as const).map(key => ({ label: label(key), value: rowText(key) })),
    sampled: sampledText, nativeBranch, details,
    omitted: Number.isSafeInteger(regexp?.detailsTruncated) && (regexp?.detailsTruncated ?? 0) > 0
      ? label('omitted', { count: number(regexp?.detailsTruncated) }) : '',
    detailsLabel: label('details'), noDetails: label('noDetails'), samplesLabel: label('samples'), title: label('title'),
  };
}

export function mountUserFilterStatus(host: HTMLElement) {
  const style = document.createElement('style');
  style.textContent = `
    .user-filter-status{font:12px/1.45 "Segoe UI","Microsoft YaHei",sans-serif;color:var(--text,#243f30);
      border:1px solid var(--border,#d1ded4);border-radius:6px;background:var(--surface,#f3f7f3);
      padding:8px 10px;max-width:100%;min-width:0;overflow-wrap:anywhere}
    .user-filter-status [hidden]{display:none!important}.user-filter-status__head{display:flex;gap:3px 10px;
      align-items:baseline;flex-wrap:wrap}.user-filter-status__head strong{font-size:12px}
    .user-filter-status__source,.user-filter-status__read,.user-filter-status__metrics,
    .user-filter-status__sample{color:var(--muted,#597361);font-size:11px}
    .user-filter-status__source{min-width:0}.user-filter-status__state{margin:2px 0 0;font-weight:600}
    .user-filter-status__read{margin:0 0 4px}.user-filter-status__rows{display:grid;gap:2px}
    .user-filter-status__row{display:flex;gap:5px 10px;flex-wrap:wrap}
    .user-filter-status__row b{font-weight:600;min-width:45px}.user-filter-status__metrics{min-width:0;flex:1 1 180px}
    .user-filter-status__sample{margin:5px 0 0}.user-filter-status details{margin-top:5px;border-top:1px solid var(--border,#d1ded4);padding-top:4px}
    .user-filter-status summary{cursor:pointer;max-width:100%;font-size:11px}
    .user-filter-status summary:focus-visible{outline:2px solid var(--accent,#4b9468);outline-offset:2px}
    .user-filter-status ol{margin:4px 0 0;padding-inline-start:24px;font-size:11px}
    .user-filter-status li{padding:2px 0}.user-filter-status__omitted{font-size:11px;margin:3px 0 0}
  `;
  const panel = document.createElement('section'); panel.className = 'user-filter-status';
  const head = document.createElement('div'); head.className = 'user-filter-status__head';
  const title = document.createElement('strong'), source = document.createElement('span');
  source.className = 'user-filter-status__source'; head.append(title, source);
  const state = document.createElement('p'); state.className = 'user-filter-status__state'; state.setAttribute('role', 'status');
  const read = document.createElement('p'); read.className = 'user-filter-status__read';
  const rows = document.createElement('div'); rows.className = 'user-filter-status__rows';
  const rowNodes = Array.from({ length: 4 }, () => {
    const row = document.createElement('div'); row.className = 'user-filter-status__row';
    const name = document.createElement('b'), value = document.createElement('span');
    value.className = 'user-filter-status__metrics'; row.append(name, value); rows.append(row);
    return { name, value };
  });
  const sample = document.createElement('p'); sample.className = 'user-filter-status__sample';
  const nativeBranch = document.createElement('p'); nativeBranch.className = 'user-filter-status__sample';
  const details = document.createElement('details'), detailsTitle = document.createElement('summary');
  const list = document.createElement('ol'), omitted = document.createElement('p'), limitation = document.createElement('p');
  limitation.className = 'user-filter-status__omitted';
  omitted.className = 'user-filter-status__omitted'; details.append(detailsTitle, list, omitted, limitation);
  panel.append(head, state, read, rows, sample, nativeBranch, details); host.append(style, panel);
  let view: UserFilterStatusView = { connected: false, stale: false, featureEnabled: false };
  const render = () => {
    const value = userFilterStatusText(view);
    title.textContent = value.title; source.textContent = value.source; state.textContent = value.state;
    read.textContent = `${value.read} · ${value.coverage}`;
    rowNodes.forEach((node, index) => {
      node.name.textContent = value.rows[index]!.label; node.value.textContent = value.rows[index]!.value;
    });
    sample.textContent = `${value.samplesLabel} · ${value.sampled}`;
    nativeBranch.textContent = value.nativeBranch; nativeBranch.hidden = !value.nativeBranch;
    detailsTitle.textContent = `${value.detailsLabel} (${value.details.length})`;
    list.replaceChildren(...(value.details.length ? value.details : [value.noDetails]).map(item => {
      const li = document.createElement('li'); li.textContent = item; return li;
    }));
    omitted.textContent = value.omitted; omitted.hidden = !value.omitted;
    limitation.textContent = label('uncovered');
    const unavailable = !view.connected || view.stale || view.readFailed || !view.featureEnabled || !view.summary;
    for (const node of [read, rows, sample, details]) node.hidden = !!unavailable;
    nativeBranch.hidden = !!unavailable || !value.nativeBranch;
  };
  const unsubscribe = onLocaleChange(render); render();
  return {
    update(next: UserFilterStatusView) { view = next; render(); },
    dispose() { unsubscribe(); style.remove(); panel.remove(); },
  };
}
