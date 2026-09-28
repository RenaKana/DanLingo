import { formatNumber, getLocale, onLocaleChange } from '../i18n/text.ts';

export interface UserFilterStatusView {
  connected: boolean;
  stale: boolean;
  featureEnabled: boolean;
  resourceId?: string;
  tabId?: number;
  summary?: Record<string, any> | null;
  readFailed?: boolean;
}

const en = {
  title: 'Bilibili block rules', source: 'Video', tab: 'Tab', selectTab: 'Video tab', chooseTab: 'Select a video tab', disconnected: 'No video tab connected',
  stale: 'Rule status expired', readFailed: 'Could not read rule status', featureOff: 'Feature off',
  reading: 'Reading rules', nativeOff: 'Bilibili native block rules off', nativeUnknown: 'Native switch unknown',
  all: 'All declared categories covered', partial: 'Declared categories partly covered',
  unknown: 'Coverage unconfirmed', readComplete: 'Rule list read', readPartial: 'Rule list incomplete',
  readUnknown: 'Read status unknown', keyword: 'Keywords', regexp: 'Regular expressions',
  sender: 'Senders', account: 'Accounts', enabled: 'enabled', supported: 'supported',
  unsupported: 'unsupported', degraded: 'degraded', ready: 'covered', disabled: 'off',
  partly: 'partial', unconfirmed: 'unknown', count: '{enabled} enabled · {supported} supported',
  regexpCount: '{enabled} enabled · {supported} supported · {unsupported} unsupported · {degraded} degraded',
  accountUnknown: 'Unknown: account blacklist is not the danmaku sender list',
  samples: 'Candidate sampled hits', sampleCounts: 'keyword {keyword} · regexp {regexp} · sender {sender}',
  samplesUnknown: 'No sample count yet', nativeBranch: 'Observed native rule branch: {count}',
  details: 'Regular expression details', noDetails: 'No rule details available', omitted: '{count} more entries not shown',
  supportedRule: 'supported', unsupportedRule: 'unsupported', previous: 'Previous classification: {reason}',
  reasonUnknown: 'Reason unavailable', reasonOther: 'Unsupported or unverified rule',
  uncovered: 'Uncovered or temporarily unknown rules do not exclude translation work. Bilibili still controls display, so extra pretranslation may occur.',
  'source-unavailable': 'Rule source unavailable', 'account-blacklist-is-not-danmaku-sender-list': 'Account blacklist is separate from sender rules',
  'unsafe-or-invalid-regexp': 'Regex unsupported or invalid', 'rule-size-limit': 'Rule exceeds size limit',
  'pattern-size-limit': 'Pattern exceeds size limit', 'invalid-native-regexp': 'Invalid native regex',
  backreference: 'Backreference is unsupported', lookaround: 'Lookaround is unsupported',
  group: 'Group is unsupported', alternation: 'Alternation is unsupported',
  quantifier: 'Quantifier is unsupported', 'unsupported-escape': 'Escape is unsupported',
  'work-limit': 'Work limit reached', 'unsupported-flags': 'Flags are unsupported',
  'unsupported-feature': 'Regex feature is unsupported', 'native-invalid': 'Native regex is invalid',
  'nested-variable-repetition': 'Nested variable repetition has no reliable synchronous work bound',
  'ambiguous-repeated-group': 'A repeated group contains alternatives that can multiply backtracking',
  'zero-width-repetition': 'A repeated group is empty or contains an assertion',
  'repetition-size-limit': 'Repetition count exceeds the bounded matcher limit',
  'syntax-complexity-limit': 'Pattern has too many syntax nodes, alternatives or repeated parts',
  'group-depth-limit': 'Group nesting exceeds the supported depth',
  'lookaround-or-named-group': 'Lookaround or named group is outside the current subset',
  'unsupported-character-class': 'Character class syntax could not be verified',
  'unsupported-quantifier-syntax': 'Quantifier syntax could not be verified',
} as const;

const zh: Record<keyof typeof en, string> = {
  title: 'Bilibili 屏蔽规则', source: '视频', tab: '标签页', selectTab: '视频标签页', chooseTab: '选择视频标签页', disconnected: '未连接视频标签页',
  stale: '规则状态已过期', readFailed: '规则状态读取失败', featureOff: '功能已关闭',
  reading: '正在读取规则', nativeOff: 'Bilibili 原生屏蔽已关闭', nativeUnknown: '原生开关未知',
  all: '已声明类别全部覆盖', partial: '已声明类别部分覆盖', unknown: '覆盖待确认',
  readComplete: '规则列表已读取', readPartial: '规则列表不完整', readUnknown: '读取状态未知',
  keyword: '关键词', regexp: '正则', sender: '发送者', account: '账号',
  enabled: '已启用', supported: '可支持', unsupported: '不支持', degraded: '降级',
  ready: '已覆盖', disabled: '已关闭', partly: '部分覆盖', unconfirmed: '未知',
  count: '已启用 {enabled} · 可支持 {supported}',
  regexpCount: '已启用 {enabled} · 可支持 {supported} · 不支持 {unsupported} · 降级 {degraded}',
  accountUnknown: '未知：账号黑名单不是弹幕发送者名单',
  samples: '当前候选采样命中', sampleCounts: '关键词 {keyword} · 正则 {regexp} · 发送者 {sender}',
  samplesUnknown: '暂无采样计数', nativeBranch: '观察到原生规则分支 {count} 次',
  details: '正则条目', noDetails: '暂无规则明细', omitted: '另有 {count} 条未展示',
  supportedRule: '支持', unsupportedRule: '不支持', previous: '原分类：{reason}',
  reasonUnknown: '原因未知', reasonOther: '规则不支持或未确认',
  uncovered: '未覆盖或暂时无法判断的规则不参与前置排除；Bilibili 仍按自身规则显示弹幕，因此可能有额外预译。',
  'source-unavailable': '规则来源不可用', 'account-blacklist-is-not-danmaku-sender-list': '账号黑名单与发送者规则不同',
  'unsafe-or-invalid-regexp': '正则不支持或无效', 'rule-size-limit': '规则超过长度限制',
  'pattern-size-limit': '表达式超过长度限制', 'invalid-native-regexp': '原生正则无效',
  backreference: '暂不支持反向引用', lookaround: '暂不支持环视', group: '暂不支持分组',
  alternation: '暂不支持分支', quantifier: '暂不支持量词', 'unsupported-escape': '暂不支持该转义',
  'work-limit': '匹配工作量超过限制', 'unsupported-flags': '暂不支持该标志',
  'unsupported-feature': '暂不支持该正则特性', 'native-invalid': '原生正则无效',
  'nested-variable-repetition': '可变量词嵌套，当前同步匹配无法可靠约束工作量',
  'ambiguous-repeated-group': '重复分组内含分支，回溯可能成倍增加',
  'zero-width-repetition': '重复分组可为空或含断言，暂未覆盖',
  'repetition-size-limit': '重复次数超过当前匹配器上限',
  'syntax-complexity-limit': '语法节点、分支或重复段数量超过上限',
  'group-depth-limit': '分组嵌套超过支持深度',
  'lookaround-or-named-group': '当前范围不含环视或具名分组',
  'unsupported-character-class': '字符类语法尚未核实',
  'unsupported-quantifier-syntax': '量词语法尚未核实',
};

type Label = keyof typeof en;
const label = (key: Label, values: Record<string, string | number> = {}) => {
  const dictionary = getLocale().startsWith('zh') ? zh : en;
  return dictionary[key].replace(/\{([a-z]+)\}/g, (match, name) =>
    values[name] === undefined ? match : String(values[name]));
};
const number = (value: unknown): string => Number.isSafeInteger(value) && (value as number) >= 0
  ? formatNumber(value as number) : '—';
const code = (value: unknown): string => typeof value === 'string' && /^[a-z][a-z0-9-]{0,80}$/.test(value) ? value : '';
const reason = (value: unknown): string => {
  const safe = code(value);
  if (!safe) return label('reasonUnknown');
  return label(safe in en ? safe as Label : 'reasonOther');
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
