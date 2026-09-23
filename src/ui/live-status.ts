import type { RuntimeStatus } from '../core/types';

const connectionLabels = {
  connecting: '正在连接', connected: '已连接', reconnecting: '正在重连',
  disconnected: '连接已断开', ended: '直播已结束',
};
const count = (value: number | undefined) => Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : 0;
const statusNote = (value: string | undefined) => (value || '')
  .replace(/(?:[，,]\s*)?过载可调整弹幕[^，,。；;]*/g, '')
  .trim();

/** Live ratios describe the recent eligible window, never an entire comment pool. */
export function liveStatusText(status: RuntimeStatus) {
  const connection = status.connection ? connectionLabels[status.connection] : '等待连接';
  const note = statusNote(status.note);
  const state = status.state === 'disabled' ? '翻译已关闭' : status.state === 'configuration-needed' ? '请先配置翻译服务'
    : status.state === 'unsupported' ? note || '当前直播暂不可用'
    : status.state === 'finding-player' ? '等待播放器'
    : status.state === 'degraded' ? `${connection} · ${note || '暂时使用原文'}` : connection;
  const eligible = count(status.recentEligible);
  const translated = Math.min(eligible, count(status.recentTranslated));
  const recent = eligible ? `近期译文 ${translated}/${eligible}（${Math.floor(translated / eligible * 100)}%）`
    : status.recentEligible === 0 ? '近期暂无待译消息' : '近期译文 —';
  const metrics = `${status.platform === 'bilibili' ? `聊天译文 ${count(status.translated)} · ` : ''}${recent} · 超时原文 ${count(status.timedOut)} · 过载 ${count(status.overloaded)}`
    + (status.platform === 'bilibili' ? ` · 显示未确认 ${count(status.liveMetrics?.unconfirmed)} · 补翻生成/回写 ${count(status.liveMetrics?.repaired)}/${count(status.liveMetrics?.repairApplied)}` : '')
    + (count(status.dropped) ? ` · 丢弃 ${count(status.dropped)}` : '');
  const coverage = status.platform === 'bilibili' ? '范围：原生聊天；不含屏幕弹幕和醒目留言'
    : status.coverage === 'top' ? '范围：热门聊天（Top chat）'
    : status.coverage === 'all' ? '范围：全部聊天' : '范围未知';
  return { state, metrics, coverage };
}

/** Attach only to an in-flow outer player container. Unsafe layouts stay hidden. */
export function createLiveStatus() {
  const host = document.createElement('div');
  host.id = 'danlingo-live-status';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host{all:initial;display:block;position:static;margin-top:8px;width:100%;min-width:0;font:12px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;color:#243f30;color-scheme:light}
    :host([hidden]){display:none!important}*{box-sizing:border-box}.panel{display:inline-flex;gap:4px 12px;flex-wrap:wrap;align-items:center;max-width:100%;padding:7px 10px;border:1px solid #d1ded4;border-radius:8px;background:#f3f7f3;overflow-wrap:anywhere}
    .mark{font-weight:700;color:#215c3e}.metrics,.coverage,.model{color:#526c5a;font-size:11px}.model{max-width:48ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}[hidden]{display:none!important}
  </style><div class="panel"><span class="mark">译</span><span id="state" role="status"></span><span id="model" class="model" hidden></span><span id="metrics" class="metrics"></span><span id="coverage" class="coverage"></span></div>`;
  let anchor: HTMLElement | null = null;
  let active = false;
  let disposed = false;
  function visibility() {
    host.hidden = disposed || !active || !anchor?.isConnected || !!document.fullscreenElement;
    if (host.hidden || !anchor) return;
    const playerBox = anchor.getBoundingClientRect();
    const box = host.getBoundingClientRect();
    if (!playerBox.width || !playerBox.height || box.top < playerBox.bottom - 1) host.hidden = true;
  }
  const resize = new ResizeObserver(visibility);
  document.addEventListener('fullscreenchange', visibility);
  return {
    repairControl(control: HTMLElement | null) {
      root.querySelector('#danlingo-live-repairs')?.remove();
      if (control) root.querySelector('.panel')!.append(control);
    },
    attach(player: HTMLElement | null, embeddedVideo?: HTMLVideoElement | null) {
      if (disposed) return;
      const parent = player?.parentElement;
      const style = player && getComputedStyle(player);
      const parentStyle = parent && getComputedStyle(parent);
      const flow = parentStyle && (['block', 'flow-root'].includes(parentStyle.display)
        || parentStyle.display === 'flex' && parentStyle.flexDirection === 'column');
      const frame = embeddedVideo?.ownerDocument.defaultView?.frameElement;
      const next = player && parent && flow && style && !['absolute', 'fixed'].includes(style.position)
        && (player.tagName === 'VIDEO' || player.querySelector('video') || embeddedVideo?.isConnected && frame && player.contains(frame)) ? player : null;
      if (next !== anchor) {
        resize.disconnect(); anchor = next;
        if (anchor) { resize.observe(anchor); resize.observe(anchor.parentElement!); }
      }
      if (anchor) { if (anchor.nextElementSibling !== host) anchor.after(host); }
      else host.remove();
      visibility();
    },
    update(status: RuntimeStatus, modelSummary = '') {
      if (disposed) return;
      const text = liveStatusText(status);
      for (const id of ['state', 'metrics', 'coverage'] as const) root.getElementById(id)!.textContent = text[id];
      const model = root.getElementById('model')!;
      model.textContent = modelSummary; model.title = modelSummary; model.hidden = !modelSummary;
      active = status.scenario === 'live';
      visibility();
    },
    dispose() {
      disposed = true; resize.disconnect();
      document.removeEventListener('fullscreenchange', visibility); host.remove(); anchor = null;
    },
  };
}
