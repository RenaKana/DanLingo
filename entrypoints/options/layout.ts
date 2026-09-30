
import { t, tCount } from '../../src/i18n';
import { bindLocalizedAttribute, bindLocalizedText } from '../../src/ui/localized-text';
import { mountCompactService, mountLocalService } from './service-layout';

const sections = {
  service: ['m_83095a6428e8', 'm_ade6d377b28b'],
  watching: ['m_41ed2767d1c6', 'm_e4bbe2bb4b3d'],
  live: ['m_c07e46641f5c', 'm_7220f4c3911c'],
  performance: ['m_7c185a12004e', 'm_a39397a3b8dc'],
  advanced: ['m_a42c8d6a892a', 'm_78aba5a7a00b'],
  data: ['m_afcc9b5e1596', 'm_4595422d43bc'],
  help: ['settings.help', 'settings.help'],
} as const;
type Section = keyof typeof sections;
const get = (id: string) => document.getElementById(id)!;
const create = (tag: string, className = '') => { const node = document.createElement(tag); node.className = className; return node; };
export function mountSettingsLayout() {
  const main = document.querySelector<HTMLElement>('main.options')!, form = get('settings-form') as HTMLFormElement;
  const cards = [...form.querySelectorAll<HTMLElement>(':scope > .card')];
  const [service, watching, live, advanced] = cards;
  const data = main.querySelector<HTMLElement>(':scope > .card')!, diagnostics = main.querySelector<HTMLElement>(':scope > details')!;
  const actions = form.querySelector<HTMLElement>(':scope > .actions')!;
  const panels = Object.fromEntries(Object.entries(sections).map(([id, [titleKey]]) => {
    const panel = create('section'); panel.dataset.section = id; bindLocalizedAttribute(panel, 'aria-label', () => t(titleKey)); form.append(panel); return [id, panel];
  })) as Record<Section, HTMLElement>;
  panels.service.append(service!); panels.watching.append(watching!); panels.live.append(live!); panels.advanced.append(advanced!); panels.data.append(data);
  data.style.marginTop = ''; diagnostics.classList.add('card'); panels.data.append(diagnostics);
  const notice = main.querySelector<HTMLElement>(':scope > .notice'); if (notice) panels.data.append(notice);
  const titleCard = (render: string | (() => string)) => {
    const card = create('div', 'card'), heading = create('h2');
    if (typeof render === 'string') heading.textContent = render; else bindLocalizedText(heading, render);
    card.append(heading); return card;
  };
  const backend = get('backend').closest('label')!;
  backend.firstChild!.textContent = ''; bindLocalizedAttribute(get('backend'), 'aria-label', () => t('m_da4ace1c0a46'));
  const modeCard = titleCard(() => t('m_da4ace1c0a46')); modeCard.classList.add('backend-card'); modeCard.append(backend); service!.before(modeCard);
  const shortcutRow = get('translation-shortcut').closest<HTMLElement>('.row')!;
  shortcutRow.classList.add('shortcut-row'); modeCard.append(shortcutRow);
  const online = create('div', 'grid'); online.dataset.backend = 'online';
  for (const id of ['endpoint','local-http','model','thinking-effort','api-key','remember','key-state']) {
    const node = id === 'model' ? get(id).closest('.model-control')! : id === 'key-state' ? get(id) : get(id).closest('label')!;
    online.append(node);
  }
  const serviceGrid = service!.querySelector('.grid')!; serviceGrid.prepend(online); online.classList.add('span');
  const local = get('local-settings'); local.classList.remove('span'); local.classList.add('card'); local.dataset.backend = 'local';
  bindLocalizedAttribute(local, 'aria-label', () => t('m_44ac539067ed')); service!.before(local);
  const runtime = document.createElement('details'), summary = create('summary'); bindLocalizedText(summary, () => t('m_538e74207183'));
  const localSummary = create('div', 'status span'); localSummary.id = 'local-state-summary'; localSummary.setAttribute('role', 'status'); localSummary.setAttribute('aria-live', 'polite');
  get('local-state').before(localSummary); runtime.className = 'span'; runtime.append(summary, get('local-state'), get('local-support')); local.querySelector('.local-grid')!.append(runtime);
  get('local-state').removeAttribute('aria-live'); get('local-state').removeAttribute('role');
  mountLocalService(local);
  const connectionDetails = service!.querySelector('details')!;
  bindLocalizedText(connectionDetails.querySelector('summary')!, () => t('m_3019152503a2'));
  const sc = titleCard('Super Chat'), scGrid = create('div', 'grid');
  const onlineSc = get('superchat-thinking').closest('label')!; onlineSc.dataset.backend = 'online';
  scGrid.append(onlineSc, get('superchat-timeout').closest('label')!); sc.append(scGrid); panels.live.append(sc);
  const connectionCard = titleCard(() => t('m_1566c66f0727')); connectionCard.hidden = true;
  connectionCard.append(connectionDetails); panels.advanced.prepend(connectionCard);
  bindLocalizedText(connectionDetails.querySelector('p')!, () => t('m_e4cc63839845'));
  const info = document.createElement('details'), infoSummary = create('summary'); bindLocalizedText(infoSummary, () => t('m_3019152503a2'));
  info.className = 'span'; info.append(infoSummary, get('connection-status'), get('profile').closest('label')!);
  const serviceNote = service!.querySelector(':scope > p'); if (serviceNote) info.append(serviceNote); serviceGrid.append(info);
  bindLocalizedText(service!.querySelector('h2')!, () => t('m_da6c05c52a15'));
  mountCompactService(service!, info);
  const cacheGrid = create('div','grid'); cacheGrid.append(get('cache-size').closest('label')!, get('cache-days').closest('label')!); data.querySelector('h2')!.after(cacheGrid);
  const dataRow = data.querySelector('.row')!; dataRow.classList.add('section-actions');
  const keyCard = titleCard(() => t('m_d7e84dcfb384')); keyCard.append(get('delete-key')); panels.data.insertBefore(keyCard, diagnostics);
  for (const id of ['clear-cache','delete-key']) {
    const box = create('div','confirm'); box.id = id + '-confirm'; box.hidden = true;
    const explanation = create('p'); bindLocalizedText(explanation, () => id === 'clear-cache' ? t('m_c55c062b31fe') : t('m_21b8613d3f05'));
    const row = create('div','row');
    for (const [kind,key] of [['confirm',id === 'clear-cache' ? 'm_3c7a4fb3566d' : 'm_a3ea3c17b401'],['dismiss','m_2cd0f3be8738']] as const) { const button = document.createElement('button'); button.type='button'; button.dataset[kind] = id; bindLocalizedText(button, () => t(key)); row.append(button); }
    box.append(explanation,row); const result = create('p','status'); result.id = id + '-result'; result.setAttribute('role','status'); result.setAttribute('aria-live','polite');
    get(id).closest('.card')!.append(box,result);
  }
  const host = (id: string, panel: HTMLElement, backend: string, card = false) => { const el = create('div', card ? 'card' : ''); el.id = id; el.dataset.backend = backend; panel.append(el); return el; };
  const onlinePerformance = host('online-performance-host', panels.performance, 'both');
  const localBenchmark = host('local-benchmark-host', panels.performance, 'local', true);
  const localPerformance = host('local-performance-host', panels.advanced, 'local', true);
  const localSuperchat = host('local-superchat-host', sc, 'local');
  main.querySelector('header')!.remove();
  const header = create('header','page-header'); header.innerHTML = `<div class="page-heading"><p class="page-breadcrumb" data-i18n="m_83095a6428e8"></p><h1 id="page-title" tabindex="-1"></h1></div><div class="page-header-actions">
    <a id="running-task" class="badge" href="#performance" role="status" hidden></a>
    <div class="preferences">
      <label class="preference-control" data-theme-control><span class="sr-only" data-i18n="m_86a63f23a076">外观</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none"/></svg>
        <select id="theme" aria-label="外观" data-i18n-aria-label="m_86a63f23a076" data-i18n-title="m_86a63f23a076"><option value="system" data-i18n="m_217cfe7db1e3">跟随系统</option><option value="light" data-i18n="m_aa0819dfc4d8">浅色</option><option value="dark" data-i18n="m_a6b75d068032">深色</option></select>
        <span data-theme-status class="status" role="status" aria-live="polite" hidden></span>
      </label>
      <label class="preference-control" data-locale-control><span class="sr-only" data-i18n="locale.label">界面语言</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></svg>
        <select id="ui-locale" aria-label="界面语言" data-i18n-title="locale.label"></select>
        <span data-locale-status class="status" role="status" aria-live="polite" hidden></span>
      </label>
    </div>
  </div>`; main.prepend(header);
  const sidebar = create('aside','sidebar'); bindLocalizedAttribute(sidebar, 'aria-label', () => t('m_00127e834a9b'));
  sidebar.innerHTML = '<a class="brand" href="#service"><span class="mark" aria-hidden="true">译</span><span>DanLingo<small data-i18n="m_a2d7ec91766f">翻译设置</small></span></a><nav aria-label="设置分类" data-i18n-aria-label="m_dfb699c54378"></nav><label class="mobile-category"><span class="sr-only" data-i18n="m_dfb699c54378">设置分类</span><select id="category" data-i18n-aria-label="m_dfb699c54378"></select></label>';
  const nav = sidebar.querySelector('nav')!, category = sidebar.querySelector<HTMLSelectElement>('#category')!;
  const navIcons: Record<Section, string> = {
    service: '<rect x="4" y="4" width="16" height="6" rx="1"/><rect x="4" y="14" width="16" height="6" rx="1"/><path d="M7 7h.01M7 17h.01M11 7h6M11 17h6"/>',
    watching: '<rect x="3" y="5" width="18" height="13" rx="2"/><path d="m10 9 5 3-5 3ZM8 21h8"/>',
    live: '<path d="M4 4h16v12H9l-5 4Z"/><path d="M8 8h8M8 12h5"/>',
    performance: '<path d="M4 19V5M4 19h16M8 15v-4M13 15V7M18 15V9"/>',
    advanced: '<path d="M4 7h6M14 7h6M4 17h10M18 17h2"/><circle cx="12" cy="7" r="2"/><circle cx="16" cy="17" r="2"/>',
    data: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 4 16 4 16 0V5M4 12v7c0 4 16 4 16 0v-7"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 17h.01"/>',
  };
  for (const [id,[titleKey]] of Object.entries(sections)) {
    const a = document.createElement('a'); a.href = '#' + id;
    a.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${navIcons[id as Section]}</svg>`;
    const label = create('span'); bindLocalizedText(label, () => t(titleKey)); a.append(label); nav.append(a);
    const option = new Option('', id); bindLocalizedText(option, () => t(titleKey)); category.add(option);
  }
  const shell = create('div','settings-shell'); main.before(shell); shell.append(sidebar,main);
  actions.classList.add('save-bar'); actions.prepend(get('result')); form.append(actions); form.noValidate = true;
  const show = (focus = false) => {
    const hash = location.hash.slice(1), section: Section = Object.hasOwn(sections,hash) ? hash as Section : 'service';
    for (const [id,panel] of Object.entries(panels)) panel.hidden = id !== section;
    nav.querySelectorAll('a').forEach(a => { if (a.hash === '#' + section) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current'); });
    category.value = section;
    actions.hidden = section === 'help';
    header.querySelector<HTMLElement>('.page-breadcrumb')!.hidden = section !== 'service';
    bindLocalizedText(get('page-title'), () => t(section === 'service' ? (get('backend') as HTMLSelectElement).value === 'online' ? 'm_1760b98532ec' : 'm_8b47c15ab818' : sections[section][0]));
    if (focus) { get('page-title').focus({preventScroll:true}); window.scrollTo(0,0); }
  };
  window.addEventListener('hashchange', () => show(true)); category.addEventListener('change', () => { location.hash = category.value; }); show();
  get('backend').addEventListener('change', () => show());
  const reveal = (field: HTMLElement) => {
    const panel = field.closest<HTMLElement>('[data-section]'); if (panel) { if (location.hash !== '#' + panel.dataset.section) location.hash = panel.dataset.section!; show(); }
    for (let parent = field.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
    // hashchange may move focus to the heading; restore the invalid field after it.
    setTimeout(() => { field.focus(); field.scrollIntoView({block:'center'}); },0);
  };
  const validate = () => {
    const invalid = [...form.elements].find(el => (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) && el.willValidate && !el.validity.valid) as HTMLInputElement | HTMLSelectElement | undefined;
    if (!invalid) return true; reveal(invalid); setTimeout(() => invalid.reportValidity(),0); return false;
  };
  const tasks = new Map<string, { section: Section; label: () => string }>();
  const task = (id: string, active: boolean, section: Section = 'performance', label: () => string = () => t('m_3019ac7d103b')) => {
    if (active) tasks.set(id,{section,label}); else tasks.delete(id);
    const host = id === 'online-test' ? onlinePerformance : id === 'local-test' ? localBenchmark : undefined;
    if (host) { host.dataset.running = String(active); host.hidden = !active && host.dataset.backend !== 'both' && host.dataset.backend !== (get('backend') as HTMLSelectElement).value; }
    const entries = [...tasks.values()], link = get('running-task') as HTMLAnchorElement; link.hidden = !entries.length;
    if (entries.length) { link.href = '#' + entries[0]!.section; bindLocalizedText(link, () => entries[0]!.label() + (entries.length > 1 ? ` · ${tCount('count.tasks', entries.length)}` : '')); }
  };
  const refreshServiceTitle = () => {
    if (!location.hash || location.hash === '#service') bindLocalizedText(get('page-title'), () =>
      t((get('backend') as HTMLSelectElement).value === 'online' ? 'm_1760b98532ec' : 'm_8b47c15ab818'));
  };
  return { onlinePerformance, localBenchmark, localPerformance, localSuperchat, reveal, validate, task, refreshServiceTitle };
}
