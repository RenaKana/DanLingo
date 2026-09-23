import type { Settings } from '../core/types.ts';
import type { SchedulerStats } from '../core/scheduler.ts';

export function createProgress(onChange: (scope: Settings['translationScope'], seconds: number) => Promise<void>, onRetry: () => void) {
  const host = document.createElement('div'); host.id = 'danlingo-progress';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host{all:initial;display:block;position:static;margin-top:8px;width:100%;min-width:0;font:12px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;color:#243f30;color-scheme:light}
    :host([hidden]){display:none!important}*{box-sizing:border-box}#panel{display:inline-flex;align-items:flex-start;background:#f3f7f3;border:1px solid #d1ded4;border-radius:8px;max-width:100%}details{min-width:0;max-width:380px}
    summary{cursor:pointer;padding:7px 10px;list-style:none;display:flex;align-items:center;gap:8px}summary::-webkit-details-marker{display:none}
    summary:after{content:'⌄';margin-left:4px;color:#627c69}.mark{font-weight:700;color:#215c3e}.body{padding:0 10px 10px;display:grid;gap:8px}
    #near-progress,#coverage,#skipped{font-size:11px;color:#597361}progress{width:100%;height:4px;accent-color:#3b8153}
    label{display:flex;align-items:center;gap:8px;flex-wrap:wrap}select,input,button{font:inherit;border:1px solid #b8cbbd;border-radius:5px;padding:4px 6px;background:#fff;color:#243f30}
    input{width:66px}button{cursor:pointer}button:disabled{opacity:.6}button:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #4b9468;outline-offset:2px}
    #window-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}[hidden]{display:none!important}#note{color:#87581b;max-width:300px;overflow-wrap:anywhere}
    #retry{justify-self:start}.body p{margin:0}summary:hover{background:#215c3e08}#dismiss-progress{margin:3px 4px 0 0;border:0;background:transparent;font-size:16px;line-height:20px;padding:3px 7px}#restore-progress{font-size:12px;padding:4px 8px}
  </style><div id="panel"><details><summary aria-label="弹幕翻译进度"><span class="mark">译</span><span id="progress-summary">读取评论池…</span></summary>
    <div class="body"><progress value="0" max="1" aria-label="弹幕准备进度"></progress><span id="near-progress"></span>
    <div><p id="coverage"></p><p id="skipped" hidden></p></div>
    <label>预译范围<select id="scope"><option value="all">整个评论池</option><option value="window">提前 N 秒</option></select></label>
    <div id="window-row" hidden><label>提前<input id="window-seconds" type="number" min="5" max="3600" step="1" aria-label="提前翻译秒数">秒</label><button id="apply-window" type="button">应用</button></div>
    <p id="note" role="status" hidden></p><button id="retry" type="button" hidden>重试失败项</button></div></details><button id="dismiss-progress" type="button" aria-label="关闭翻译进度" title="关闭翻译进度">×</button></div><button id="restore-progress" type="button" hidden>显示翻译进度</button>`;
  const $ = <T extends HTMLElement>(id: string) => root.getElementById(id) as T;
  const details = root.querySelector('details')!;
  const scope = $<HTMLSelectElement>('scope'); const seconds = $<HTMLInputElement>('window-seconds');
  const apply = $<HTMLButtonElement>('apply-window'); const note = $('note');
  let dirty = false; let saving = false; let localError = '';
  let resourceId = ''; let dismissed = false; let active = false;
  let anchor: HTMLElement | null = null;
  function showDismissed() { $('panel').hidden = dismissed; $('restore-progress').hidden = !dismissed; }
  function visibility() {
    host.hidden = !active || !anchor?.isConnected || !!document.fullscreenElement;
    if (!host.hidden && anchor) {
      // Fail closed if the site's layout has changed: never become a video overlay again.
      const playerBox = anchor.getBoundingClientRect(), box = host.getBoundingClientRect();
      if (!playerBox.width || !playerBox.height || box.top < playerBox.bottom - 1) host.hidden = true;
    }
  }
  const resize = new ResizeObserver(visibility);
  document.addEventListener('fullscreenchange', visibility);
  $('dismiss-progress').addEventListener('click', () => { dismissed = true; details.open = false; showDismissed(); $('restore-progress').focus(); });
  $('restore-progress').addEventListener('click', () => { dismissed = false; showDismissed(); root.querySelector('summary')!.focus(); });
  async function save() {
    if (saving || !seconds.checkValidity()) { seconds.reportValidity(); return; }
    saving = true; scope.disabled = apply.disabled = true;
    const savedResource = resourceId;
    try { await onChange(scope.value as Settings['translationScope'], Number(seconds.value)); if (savedResource === resourceId) { dirty = false; localError = ''; } }
    catch (e) { if (savedResource === resourceId) { localError = e instanceof Error ? e.message : '设置未保存，请重试'; note.textContent = localError; note.hidden = false; } }
    finally { saving = false; scope.disabled = apply.disabled = false; }
  }
  scope.addEventListener('change', () => { $('window-row').hidden = scope.value !== 'window'; void save(); });
  seconds.addEventListener('input', () => { dirty = true; });
  apply.addEventListener('click', () => { void save(); });
  $('retry').addEventListener('click', onRetry);
  for (const event of ['click', 'dblclick', 'pointerdown', 'pointerup', 'keydown', 'keyup']) host.addEventListener(event, e => e.stopPropagation());
  root.addEventListener('keydown', e => { if ((e as KeyboardEvent).key === 'Escape') { details.open = false; root.querySelector('summary')!.focus(); } });
  return {
    attach(session: string, nextResourceId: string, platform: 'niconico' | 'bilibili' = 'niconico') {
      if (nextResourceId && nextResourceId !== resourceId) {
        resourceId = nextResourceId; dismissed = false; details.open = false; dirty = false; localError = ''; showDismissed();
      }
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
    update(settings: Settings, stats: SchedulerStats, message: string, active: boolean, collectionComplete = true) {
      const visible = settings.enabled && settings.displayMode !== 'original' && active;
      const range = collectionComplete ? '当前范围' : '当前已加载范围';
      const text = !stats.sourceComplete && !stats.messages ? '读取评论池…' : !stats.total ? `${range}暂无弹幕` : !stats.messages ? `${range}无需翻译` : `已准备 ${stats.translated} / ${stats.messages}`;
      $('progress-summary').textContent = text;
      root.querySelector('summary')!.title = `${settings.translationScope === 'all' ? collectionComplete ? '整个评论池' : '已加载分段' : `提前 ${settings.prefetchSeconds} 秒`} · 仅统计需翻译弹幕 · ${stats.failed} 条失败`;
      const progress = root.querySelector('progress')!; progress.max = Math.max(1, stats.messages); progress.value = stats.translated;
      $('near-progress').textContent = `当前位置约 ${settings.urgentSeconds} 秒 · ${stats.nearPrepared} / ${stats.nearTotal} 已准备`;
      $('coverage').textContent = `${range} ${stats.total} 条 · 需翻译 ${stats.messages} 条${stats.sourceComplete ? '' : '（读取中）'}`;
      const skipped = stats.skipped;
      const skippedTotal = skipped.special + skipped.language + skipped.emoticon;
      const reasons = [skipped.language && `语言判断/符号 ${skipped.language}`, skipped.special && `特殊样式 ${skipped.special}`, skipped.emoticon && `未识别颜文字 ${skipped.emoticon}`].filter(Boolean);
      $('skipped').textContent = `保留原文 ${skippedTotal} 条：${reasons.join(' · ')}`;
      $('skipped').hidden = !skippedTotal;
      if (!saving) { scope.value = settings.translationScope; if (!dirty) seconds.value = String(settings.prefetchSeconds); }
      $('window-row').hidden = scope.value !== 'window';
      note.textContent = localError || message || (stats.failed ? `${stats.failed} 条未完成，显示原文` : ''); note.hidden = !note.textContent;
      $('retry').hidden = !stats.failed;
      setActive(visible);
    },
    dispose() { resize.disconnect(); document.removeEventListener('fullscreenchange', visibility); host.remove(); },
  };

  function setActive(value: boolean) { active = value; visibility(); }
}
