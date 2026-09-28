import type { RuntimeStatus } from '../core/types';
import { getLocale, localizeMessage, onLocaleChange, t } from '../i18n/text.ts';
import { bindLocalizedAttribute, bindLocalizedText } from './localized-text.ts';

const connectionLabelKeys: Record<NonNullable<RuntimeStatus['connection']>, string> = {
  connecting: 'm_694186911ae3', connected: 'm_5be0323e8adc', reconnecting: 'm_7a58d3d9d3e3',
  disconnected: 'm_2ab7d89557e7', ended: 'm_924840fb8407',
};
const count = (value: number | undefined) => Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : 0;
const statusNote = (value: string | undefined) => (value || '')
  .replace(/(?:[，,]\s*)?过载可调整弹幕[^，,。；;]*/g, '')
  .trim();

/** Live ratios describe the recent eligible window, never an entire comment pool. */
export function liveStatusText(status: RuntimeStatus) {
  const connection = status.connection ? t(connectionLabelKeys[status.connection]) : t('m_d80f8bbe1ddf');
  const note = statusNote(status.note);
  const localizedNote = localizeMessage(status.noteMessage ?? note);
  const state = status.state === 'disabled' ? t('m_f2b5a88401b4') : status.state === 'configuration-needed' ? t('m_89baf1f67c7c')
    : status.state === 'unsupported' ? localizedNote || t('m_48cdf22174c6')
    : status.state === 'finding-player' ? t('m_c5470cdfa274')
    : status.state === 'degraded' ? `${connection} · ${localizedNote || t('m_7e354d90714c')}` : connection;
  const eligible = count(status.recentEligible);
  const translated = Math.min(eligible, count(status.recentTranslated));
  const recent = eligible ? t('m_5bbbd3af29f5', { p0: translated, p1: eligible, p2: Math.floor(translated / eligible * 100) })
    : status.recentEligible === 0 ? t('m_89daea60e9e5') : t('m_4738810822e0');
  const metrics = t('m_983b906e4363', { p0: status.platform === 'bilibili' ? t('m_86449f6fa6e5', { p0: count(status.translated) }) : '', p1: recent, p2: count(status.timedOut), p3: count(status.overloaded) })
    + (status.platform === 'bilibili' ? t('m_0cd5b2f19bb7', { p0: count(status.liveMetrics?.unconfirmed), p1: count(status.liveMetrics?.repaired), p2: count(status.liveMetrics?.repairApplied) }) : '')
    + (count(status.dropped) ? t('m_2a133caf153f', { p0: count(status.dropped) }) : '');
  const coverage = status.platform === 'bilibili' ? t('m_1419fbe9fd1b')
    : status.coverage === 'top' ? t('m_2f783d5458cf')
    : status.coverage === 'all' ? t('m_2a7345684544') : t('m_560bb54cfc3f');
  return { state, metrics, coverage };
}

/** Attach only to an in-flow outer player container. Unsafe layouts stay hidden. */
export function createLiveStatus() {
  const host = document.createElement('div');
  host.id = 'danlingo-live-status';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host{all:initial;display:block;position:static;margin-top:8px;width:100%;min-width:0;font:14px/1.45 "Segoe UI","Microsoft YaHei UI",sans-serif;color:#28323a;color-scheme:light}
    :host([hidden]){display:none!important}*{box-sizing:border-box}[hidden]{display:none!important}
    .panel{display:flex;gap:6px 14px;flex-wrap:wrap;align-items:center;width:100%;min-width:0;padding:8px 12px;border:1px solid #d9dfe4;border-radius:6px;background:#fff;overflow-wrap:anywhere}
    .mark{display:inline-grid;place-items:center;flex:none;width:23px;height:23px;border-radius:4px;background:#eaf2fa;color:#23649b;font-weight:700}
    #state{font-weight:600}.model,.metrics,.coverage{color:#596772;min-width:0;font-size:14px}
    .model{max-width:38ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .metrics{flex:0 1 auto}.coverage{color:#68747c}
    #danlingo-live-repairs{margin-inline-start:auto}
    @media(max-width:680px){.panel{gap:6px 10px}.metrics{flex-basis:100%;order:2}.coverage{order:3}#danlingo-live-repairs{order:4}}
  </style><div class="panel"><span class="mark">译</span><span id="state" role="status"></span><span id="model" class="model" hidden></span><span id="metrics" class="metrics"></span><span id="coverage" class="coverage"></span></div>`;
  const syncDirection = () => { host.lang = getLocale(); host.dir = getLocale() === 'ar' ? 'rtl' : 'ltr'; };
  syncDirection(); const stopLocale = onLocaleChange(syncDirection);
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
    update(status: RuntimeStatus, modelSummary: string | (() => string) = '') {
      if (disposed) return;
      bindLocalizedText(root.getElementById('state')!, () => liveStatusText(status).state);
      bindLocalizedText(root.getElementById('metrics')!, () => liveStatusText(status).metrics);
      bindLocalizedText(root.getElementById('coverage')!, () => liveStatusText(status).coverage);
      const model = root.getElementById('model')!;
      const renderModel = typeof modelSummary === 'function' ? modelSummary : () => modelSummary;
      bindLocalizedText(model, renderModel); bindLocalizedAttribute(model, 'title', renderModel); model.hidden = !renderModel();
      model.dir = 'ltr';
      active = status.scenario === 'live';
      visibility();
    },
    dispose() {
      disposed = true; resize.disconnect();
      stopLocale();
      document.removeEventListener('fullscreenchange', visibility); host.remove(); anchor = null;
    },
  };
}
