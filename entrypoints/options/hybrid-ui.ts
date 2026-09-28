import type { Settings } from '../../src/core/types';
import { localize, onLocaleChange, t } from '../../src/i18n';

interface CapacityProfile {
  identity: string;
  maxItems: number;
  maxChars: number;
  p95Ms?: number;
  sourceRecordId?: string;
  manual: boolean;
}
interface HybridDraft { enabled: boolean; profiles: CapacityProfile[] }
interface CapacityReply {
  ok: boolean;
  identity?: string;
  profile?: CapacityProfile;
  recommendation?: CapacityProfile;
}

export function mountHybridUI(options: {
  container: HTMLElement;
  readSettings: () => Settings;
  requestCapacity: (settings: Settings) => Promise<CapacityReply>;
  changed: () => void;
  enabledChanged: () => void;
  reveal: (field: HTMLElement) => void;
}) {
  const root = options.container;
  root.innerHTML = `<label class="check"><input id="bilibili-hybrid" type="checkbox" aria-controls="hybrid-controls"><span data-i18n="hybrid.label">B站本地限量 + 在线分流</span></label>
    <div id="hybrid-controls" hidden>
      <div class="hybrid-fields">
        <label><span data-i18n="hybrid.maxItems">每5秒本地新输入条数</span><input id="hybrid-max-items" type="number" min="1" max="1000" step="1" inputmode="numeric"></label>
        <label><span data-i18n="hybrid.maxChars">每5秒本地新输入字符（UTF-16）</span><input id="hybrid-max-chars" type="number" min="1" max="60000" step="1" inputmode="numeric"></label>
      </div>
      <div class="hybrid-actions"><button id="hybrid-apply" type="button" data-i18n="hybrid.apply" disabled>应用建议</button><span id="hybrid-status" class="subtle" role="status" aria-live="polite"></span></div>
      <p class="subtle" data-i18n="hybrid.note">需启用上方5秒规划并配置两端；本地超额、忙满或未就绪时使用在线服务，沿用在线每日请求上限（0 不限）。</p>
    </div>`;
  localize(root);
  const enabled = root.querySelector<HTMLInputElement>('#bilibili-hybrid')!;
  const controls = root.querySelector<HTMLElement>('#hybrid-controls')!;
  const items = root.querySelector<HTMLInputElement>('#hybrid-max-items')!;
  const chars = root.querySelector<HTMLInputElement>('#hybrid-max-chars')!;
  const apply = root.querySelector<HTMLButtonElement>('#hybrid-apply')!;
  const status = root.querySelector<HTMLElement>('#hybrid-status')!;
  let profiles: CapacityProfile[] = [];
  let identity = '', recommendation: CapacityProfile | undefined, revision = 0, errorKey = '';
  let pending: Promise<void> | undefined;

  function valid() {
    return items.validity.valid && chars.validity.valid && items.value !== '' && chars.value !== ''
      && Number.isSafeInteger(Number(items.value)) && Number.isSafeInteger(Number(chars.value));
  }
  function matched() { return profiles.find(profile => profile.identity === identity); }
  function setFields(profile?: CapacityProfile) {
    items.value = profile ? String(profile.maxItems) : '';
    chars.value = profile ? String(profile.maxChars) : '';
  }
  function retainProfiles(rows: CapacityProfile[]) {
    const byIdentity = new Map<string, CapacityProfile>();
    for (const row of rows) byIdentity.set(row.identity, row);
    return [...byIdentity.values()].slice(-50);
  }
  function render() {
    controls.hidden = !enabled.checked;
    for (const field of [items, chars]) field.disabled = enabled.checked && !!pending;
    apply.disabled = !enabled.checked || !!pending || !recommendation || !identity;
    if (!enabled.checked) { status.textContent = ''; return; }
    if (pending) { status.textContent = t('hybrid.pending'); return; }
    if (errorKey) { status.textContent = t(errorKey); return; }
    if (!identity) { status.textContent = t('hybrid.noIdentity'); return; }
    const current = matched();
    const suggestion = recommendation ? t('hybrid.suggestion', { items: recommendation.maxItems, chars: recommendation.maxChars }) : t('hybrid.noSuggestion');
    const state = current ? t(current.manual ? 'hybrid.manualLimit' : 'hybrid.appliedLimit') : t('hybrid.notApplied');
    status.textContent = t('hybrid.status', { state, suggestion });
  }
  const read = (): HybridDraft => ({ enabled: enabled.checked, profiles: [...profiles] });
  function saveProfile(profile: CapacityProfile) {
    profiles = retainProfiles([...profiles, profile]);
    setFields(profile); options.changed(); render();
  }
  function manualEdit() {
    if (!identity || !valid()) { render(); options.changed(); return; }
    const source = matched() ?? recommendation;
    saveProfile({ identity, maxItems: Number(items.value), maxChars: Number(chars.value),
      ...(source?.p95Ms === undefined ? {} : { p95Ms: source.p95Ms }),
      ...(source?.sourceRecordId === undefined ? {} : { sourceRecordId: source.sourceRecordId }), manual: true });
  }
  enabled.addEventListener('change', () => {
    options.changed(); options.enabledChanged();
    if (enabled.checked) void refresh(); else { revision++; identity = ''; recommendation = undefined; pending = undefined; errorKey = ''; render(); }
  });
  for (const input of [items, chars]) input.addEventListener('input', manualEdit);
  apply.addEventListener('click', () => {
    if (!identity || !recommendation) return;
    saveProfile({ ...recommendation, identity, manual: false });
  });

  async function refresh(): Promise<void> {
    const ticket = ++revision;
    if (!enabled.checked) { identity = ''; recommendation = undefined; pending = undefined; errorKey = ''; render(); return; }
    errorKey = '';
    const request = (async () => {
      let draft: Settings;
      try { draft = options.readSettings(); }
      catch { if (ticket === revision) { identity = ''; recommendation = undefined; errorKey = 'hybrid.fixConfig'; } return; }
      try {
        const reply = await options.requestCapacity(draft);
        if (ticket !== revision || !enabled.checked) return;
        if (!reply?.ok || !reply.identity) throw new Error('capacity-unavailable');
        const changed = identity !== reply.identity;
        identity = reply.identity;
        recommendation = reply.recommendation?.identity === identity ? reply.recommendation : undefined;
        const current = matched() ?? (reply.profile?.identity === identity ? reply.profile : undefined);
        if (current && !matched()) profiles = retainProfiles([...profiles, current]);
        if (changed) setFields(current ?? recommendation);
        render();
      } catch {
        if (ticket === revision) { identity = ''; recommendation = undefined; errorKey = 'hybrid.capacityFailed'; }
      }
    })();
    pending = request;
    render();
    await request;
    if (ticket === revision) { pending = undefined; render(); }
  }
  function fill(next?: HybridDraft) {
    ++revision; pending = undefined; identity = ''; recommendation = undefined; errorKey = '';
    enabled.checked = next?.enabled === true;
    profiles = Array.isArray(next?.profiles) ? retainProfiles(next.profiles) : [];
    setFields(); render();
    if (enabled.checked) void refresh();
  }
  async function ensureSelected() {
    if (!enabled.checked) return;
    if (pending) await pending;
    if (!identity) await refresh();
    if (!identity || !matched()) {
      options.reveal(items);
      throw new Error('HYBRID_CAPACITY_REQUIRED');
    }
    if (!valid()) { options.reveal(items.validity.valid ? chars : items); throw new Error('HYBRID_CAPACITY_INVALID'); }
  }
  const unsubscribe = onLocaleChange(() => { localize(root); render(); });
  window.addEventListener('pagehide', unsubscribe, { once: true });
  return { read, fill, refresh, ensureSelected, enabled: () => enabled.checked };
}
