const sections = {
  service: ['翻译服务', '选择服务与模型。'],
  watching: ['观看设置', '选择语言和显示方式。'],
  live: ['直播聊天', '设置直播翻译。'],
  performance: ['性能测试', '按当前配置运行测试。'],
  advanced: ['高级参数', '调整请求与本地推理。'],
  data: ['数据与诊断', '管理缓存与诊断。'],
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
  const panels = Object.fromEntries(Object.entries(sections).map(([id, [title]]) => {
    const panel = create('section'); panel.dataset.section = id; panel.setAttribute('aria-label', title); form.append(panel); return [id, panel];
  })) as Record<Section, HTMLElement>;
  panels.service.append(service!); panels.watching.append(watching!); panels.live.append(live!); panels.advanced.append(advanced!); panels.data.append(data);
  data.style.marginTop = ''; diagnostics.classList.add('card'); panels.data.append(diagnostics);
  const notice = main.querySelector<HTMLElement>(':scope > .notice'); if (notice) panels.data.append(notice);
  const titleCard = (title: string) => { const card = create('div', 'card'), heading = create('h2'); heading.textContent = title; card.append(heading); return card; };
  const backend = get('backend').closest('label')!;
  backend.firstChild!.textContent = ''; get('backend').setAttribute('aria-label', '翻译方式');
  const modeCard = titleCard('翻译方式'); modeCard.classList.add('backend-card'); modeCard.append(backend); service!.before(modeCard);
  const online = create('div', 'grid'); online.dataset.backend = 'online';
  for (const id of ['endpoint','model','thinking-effort','api-key','remember','key-state']) {
    const node = id === 'model' ? get(id).closest('.model-control')! : id === 'key-state' ? get(id) : get(id).closest('label')!;
    online.append(node);
  }
  const serviceGrid = service!.querySelector('.grid')!; serviceGrid.prepend(online); online.classList.add('span');
  const local = get('local-settings'); local.classList.remove('span'); local.classList.add('card'); local.dataset.backend = 'local';
  const localTitle = create('h2'); localTitle.textContent = '本地模型'; local.prepend(localTitle); service!.before(local);
  const runtime = document.createElement('details'), summary = create('summary'); summary.textContent = '运行明细与支持范围';
  const localSummary = create('div', 'status span'); localSummary.id = 'local-state-summary'; localSummary.setAttribute('role', 'status'); localSummary.setAttribute('aria-live', 'polite');
  get('local-state').before(localSummary); runtime.className = 'span'; runtime.append(summary, get('local-state'), get('local-support')); local.querySelector('.local-grid')!.append(runtime);
  get('local-state').removeAttribute('aria-live'); get('local-state').removeAttribute('role');
  const connectionDetails = service!.querySelector('details')!;
  connectionDetails.querySelector('summary')!.textContent = '连接与协议';
  const sc = titleCard('Super Chat'), scGrid = create('div', 'grid');
  const onlineSc = get('superchat-thinking').closest('label')!; onlineSc.dataset.backend = 'online';
  scGrid.append(onlineSc, get('superchat-timeout').closest('label')!); sc.append(scGrid); panels.live.append(sc);
  const connectionCard = titleCard('高级连接'); connectionCard.dataset.backend = 'online';
  connectionCard.append(connectionDetails); connectionDetails.querySelector('.grid')!.append(get('local-http').closest('label')!); panels.advanced.prepend(connectionCard);
  connectionDetails.querySelector('p')!.textContent = '连接失败时，请按服务提供方的说明填写路径和思考配置。';
  const info = document.createElement('details'), infoSummary = create('summary'); infoSummary.textContent = '连接说明';
  info.className = 'span'; info.append(infoSummary, get('connection-status'));
  const serviceNote = service!.querySelector(':scope > p'); if (serviceNote) info.append(serviceNote); serviceGrid.append(info);
  service!.querySelector('h2')!.textContent = '连接与模型';
  const cacheGrid = create('div','grid'); cacheGrid.append(get('cache-size').closest('label')!, get('cache-days').closest('label')!); data.querySelector('h2')!.after(cacheGrid);
  const dataRow = data.querySelector('.row')!; dataRow.classList.add('section-actions');
  const keyCard = titleCard('服务凭据'); keyCard.append(get('delete-key')); panels.data.insertBefore(keyCard, diagnostics);
  for (const id of ['clear-cache','delete-key']) {
    const box = create('div','confirm'); box.id = id + '-confirm'; box.hidden = true;
    const explanation = create('p'); explanation.textContent = id === 'clear-cache' ? '清空后可能重新翻译。' : '删除后需重新配置在线凭据。';
    const row = create('div','row');
    for (const [kind,label] of [['confirm',id === 'clear-cache' ? '确认清空' : '确认删除'],['dismiss','取消']]) { const button = document.createElement('button'); button.type='button'; button.dataset[kind!] = id; button.textContent = label!; row.append(button); }
    box.append(explanation,row); const result = create('p','status'); result.id = id + '-result'; result.setAttribute('role','status'); result.setAttribute('aria-live','polite');
    get(id).closest('.card')!.append(box,result);
  }
  const host = (id: string, panel: HTMLElement, backend: string, card = false) => { const el = create('div', card ? 'card' : ''); el.id = id; el.dataset.backend = backend; panel.append(el); return el; };
  const onlinePerformance = host('online-performance-host', panels.performance, 'both');
  const localBenchmark = host('local-benchmark-host', panels.performance, 'local', true);
  const localPerformance = host('local-performance-host', panels.advanced, 'local', true);
  const localSuperchat = host('local-superchat-host', sc, 'local');
  main.querySelector('header')!.remove();
  const header = create('header','page-header'); header.innerHTML = '<div><p class="eyebrow">设置</p><h1 id="page-title" tabindex="-1"></h1><p id="page-description" class="subtle"></p></div><a id="running-task" class="badge" href="#performance" role="status" hidden></a>'; main.prepend(header);
  const sidebar = create('aside','sidebar'); sidebar.setAttribute('aria-label','设置导航');
  sidebar.innerHTML = '<a class="brand" href="#service"><span class="mark" aria-hidden="true">译</span><span>DanLingo<small>翻译设置</small></span></a><nav aria-label="设置分类"></nav><label class="mobile-category">设置分类<select id="category"></select></label><div class="sidebar-bottom"><label>外观<select id="theme"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label><p class="subtle">在弹幕中看懂另一种语言。</p></div>';
  const themeStatus = create('p','status'); themeStatus.dataset.themeStatus = ''; themeStatus.hidden = true; themeStatus.setAttribute('role','status'); sidebar.querySelector('#theme')!.parentElement!.append(themeStatus);
  const nav = sidebar.querySelector('nav')!, category = sidebar.querySelector<HTMLSelectElement>('#category')!;
  for (const [id,[title]] of Object.entries(sections)) { const a = document.createElement('a'); a.href = '#' + id; a.textContent = title; nav.append(a); category.add(new Option(title,id)); }
  const shell = create('div','settings-shell'); main.before(shell); shell.append(sidebar,main);
  actions.classList.add('save-bar'); actions.prepend(get('result')); form.append(actions); form.noValidate = true;
  const show = (focus = false) => {
    const hash = location.hash.slice(1), section: Section = Object.hasOwn(sections,hash) ? hash as Section : 'service';
    for (const [id,panel] of Object.entries(panels)) panel.hidden = id !== section;
    nav.querySelectorAll('a').forEach(a => { if (a.hash === '#' + section) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current'); });
    category.value = section; get('page-title').textContent = sections[section][0]; get('page-description').textContent = sections[section][1];
    if (focus) { get('page-title').focus({preventScroll:true}); window.scrollTo(0,0); }
  };
  window.addEventListener('hashchange', () => show(true)); category.addEventListener('change', () => { location.hash = category.value; }); show();
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
  const tasks = new Map<string, { section: Section; label: string }>();
  const task = (id: string, active: boolean, section: Section = 'performance', label = '测试运行中') => {
    if (active) tasks.set(id,{section,label}); else tasks.delete(id);
    const host = id === 'online-test' ? onlinePerformance : id === 'local-test' ? localBenchmark : undefined;
    if (host) { host.dataset.running = String(active); host.hidden = !active && host.dataset.backend !== 'both' && host.dataset.backend !== (get('backend') as HTMLSelectElement).value; }
    const entries = [...tasks.values()], link = get('running-task') as HTMLAnchorElement; link.hidden = !entries.length;
    if (entries.length) { link.href = '#' + entries[0]!.section; link.textContent = entries[0]!.label + (entries.length > 1 ? ` · ${entries.length} 项` : ''); }
  };
  return { onlinePerformance, localBenchmark, localPerformance, localSuperchat, reveal, validate, task };
}
