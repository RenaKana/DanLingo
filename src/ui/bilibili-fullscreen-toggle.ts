import { localizeMessage, onLocaleChange, t } from '../i18n/text.ts';

const playerSelector = '#playerWrap, .player-wrap, .bpx-player-container';
const playerMarkerSelector = '[data-danlingo-player]';
const danmakuControlSelector = '.bpx-player-dm-switch';
const controlRegionSelector = '.bpx-player-dm-root';

export function mountBilibiliFullscreenToggle(onToggle: (enabled: boolean) => Promise<void>, readShortcut?: () => Promise<string>) {
  const button = document.createElement('button');
  button.id = 'danlingo-fullscreen-toggle';
  button.type = 'button';
  button.className = 'danlingo-fullscreen-toggle';
  button.hidden = true;
  button.style.cssText = 'box-sizing:border-box;position:relative;display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;width:24px;height:24px;min-width:0;margin:0;padding:0;border:0;border-radius:0;background:transparent;color:rgba(255,255,255,.9);line-height:1;vertical-align:middle;cursor:pointer;';
  button.setAttribute('data-danlingo-fullscreen-toggle', '');

  // Keep both states on the same TV silhouette, like the adjacent native controls.
  const screen = '<path d="m8 3 3 4m7-4-3 4M22.5 16v-4A4.5 4.5 0 0 0 18 7.5H7A4.5 4.5 0 0 0 2.5 12v8A4.5 4.5 0 0 0 7 24.5h7" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/><text x="12.5" y="20" fill="currentColor" text-anchor="middle" font-family="Arial,Microsoft YaHei,sans-serif" font-size="12" font-weight="600">译</text>';
  const makeIcon = (state: string) => {
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.style.cssText = 'display:block;flex:none;width:24px;height:24px;line-height:0;pointer-events:none;';
    icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="100%" height="100%" style="display:block;overflow:visible">${screen}${state}</svg>`;
    return icon;
  };
  const onIcon = makeIcon('<path d="m17 22 3.2 3.2 6.3-7" fill="none" stroke="#00aeec" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>');
  const offIcon = makeIcon('<g fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="22" cy="22.5" r="4.4"/><path d="m19 19.5 6 6"/></g>');
  button.append(onIcon, offIcon);

  const tooltip = document.createElement('div');
  tooltip.id = 'danlingo-translation-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  // Match the player's tooltip without assigning native classes or handlers.
  tooltip.style.cssText = 'box-sizing:border-box;position:fixed;z-index:12000;width:max-content;max-width:18em;padding:6px 8px;border-radius:2px;background:var(--bpx-tooltip-bgcolor,#000);color:var(--bpx-tooltip-color,#fff);font:400 12px/1.5 Arial,Microsoft YaHei,sans-serif;white-space:normal;overflow-wrap:anywhere;pointer-events:none;user-select:none;';

  let enabled = false;
  let session = '';
  let busy = false;
  let failed = false;
  let failure: unknown;
  let disposed = false;
  let requestRevision = 0;
  let stateRevision = 0;
  let observedRegion: Element | null = null;
  let observedParent: Element | null = null;
  let hovered = false;
  let shortcut = '';
  let shortcutRead: Promise<void> | null = null;

  function render() {
    const action = enabled ? t('watch.translationOn') : t('watch.translationOff');
    const failureDetail = failed ? localizeMessage(failure) : '';
    const detail = failed ? [t('m_6ade7baf8737'), failureDetail].filter(Boolean).join(' ') : busy ? t('m_6bdb4435095e') : '';
    const label = detail ? `${action} · ${detail}` : action;
    button.setAttribute('aria-pressed', String(enabled));
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-busy', String(busy));
    const tooltipAction = enabled ? t('watch.disableTranslation') : t('watch.enableTranslation');
    const tooltipLabel = detail || (shortcut ? t('watch.actionWithShortcut', { action: tooltipAction, shortcut }) : tooltipAction);
    if (tooltip.textContent !== tooltipLabel) tooltip.textContent = tooltipLabel;
    // A title would produce a second, delayed browser tooltip.
    button.removeAttribute('title');
    button.disabled = busy;
    onIcon.style.display = enabled ? 'block' : 'none';
    offIcon.style.display = enabled ? 'none' : 'block';
    if (tooltip.isConnected) positionTooltip();
  }

  function hideTooltip() {
    tooltip.remove();
    button.removeAttribute('aria-describedby');
  }

  function refreshShortcut() {
    if (!readShortcut || disposed || shortcutRead) return;
    // Read again on hover/focus so browser-level remapping needs no page reload.
    shortcutRead = Promise.resolve().then(readShortcut).then(value => {
      if (!disposed) { shortcut = typeof value === 'string' ? value.trim() : ''; render(); }
    }).catch(() => {
      if (!disposed) { shortcut = ''; render(); }
    }).finally(() => { shortcutRead = null; });
  }

  function positionTooltip() {
    const rect = button.getBoundingClientRect();
    const size = tooltip.getBoundingClientRect();
    const viewport = document.documentElement.clientWidth;
    tooltip.style.left = `${Math.max(4, Math.min(rect.left + (rect.width - size.width) / 2, viewport - size.width - 4))}px`;
    tooltip.style.top = `${Math.max(4, rect.top - size.height - 6)}px`;
  }

  function showTooltip() {
    if (disposed || !button.isConnected || button.hidden) return;
    refreshShortcut();
    const host = document.fullscreenElement ?? document.body;
    if (tooltip.parentNode !== host) host.append(tooltip);
    button.setAttribute('aria-describedby', tooltip.id);
    positionTooltip();
  }

  function matchNativeGeometry(anchor: HTMLElement) {
    // Player styles set their own control size and spacing in each screen mode. Copy only
    // geometry, without native classes that could acquire the player's handlers.
    const nativeStyle = getComputedStyle(anchor);
    button.style.width = parseFloat(nativeStyle.width) > 0 ? nativeStyle.width : '24px';
    button.style.height = parseFloat(nativeStyle.height) > 0 ? nativeStyle.height : '24px';
    button.style.margin = nativeStyle.margin;
    const nativeIcon = anchor.querySelector('svg');
    const iconStyle = nativeIcon ? getComputedStyle(nativeIcon) : nativeStyle;
    const fill = iconStyle.fill;
    button.style.color = fill && fill !== 'none' ? fill : nativeStyle.color || '#757575';
    const iconWidth = parseFloat(iconStyle.width) > 0 ? iconStyle.width : '24px';
    const iconHeight = parseFloat(iconStyle.height) > 0 ? iconStyle.height : '24px';
    for (const icon of [onIcon, offIcon]) {
      icon.style.width = iconWidth;
      icon.style.height = iconHeight;
    }
  }

  function findPlayer(): HTMLElement | null {
    if (!session) return null;
    for (const marker of document.querySelectorAll<HTMLElement>(playerMarkerSelector)) {
      if (!marker.isConnected || marker.dataset.danlingoPlayer !== session) continue;
      const root = marker.closest<HTMLElement>(playerSelector);
      if (root?.isConnected && root.contains(marker)) return root;
    }
    return null;
  }

  function findControl(root: HTMLElement | null): HTMLElement | null {
    if (!root) return null;
    const anchor = root.querySelector<HTMLElement>(danmakuControlSelector);
    return anchor?.isConnected && root.contains(anchor) ? anchor : null;
  }

  function observeControls(root: HTMLElement | null, anchor: HTMLElement | null) {
    const preferred = root?.querySelector<HTMLElement>(controlRegionSelector) ?? null;
    const region = preferred && (!anchor || preferred.contains(anchor)) ? preferred : anchor?.parentElement ?? preferred;
    const parent = region?.parentElement ?? null;
    if (region === observedRegion && parent === observedParent) return;
    observer.disconnect();
    observedRegion = region;
    observedParent = parent;
    if (region?.isConnected) observer.observe(region, { childList: true, subtree: true });
    if (parent?.isConnected && parent !== region) observer.observe(parent, { childList: true });
  }

  function fullscreenContains(element: Element, fullScreen: Element) {
    return fullScreen === element || fullScreen.contains(element);
  }

  function visibleWithPlayer(root: HTMLElement, anchor: HTMLElement) {
    const fullScreen = document.fullscreenElement;
    if (!fullScreen) return true;
    const samePlayerSurface = fullscreenContains(root, fullScreen);
    const video = root.querySelector('video');
    const samePlayerVideo = !!video && fullscreenContains(video, fullScreen);
    return (samePlayerSurface || samePlayerVideo) && fullscreenContains(anchor, fullScreen);
  }

  function reconcile() {
    if (disposed || !session) {
      observeControls(null, null);
      hideTooltip();
      button.remove();
      return;
    }
    const root = findPlayer();
    const anchor = findControl(root);
    observeControls(root, anchor);
    if (!root || !anchor || !visibleWithPlayer(root, anchor) || !anchor.parentNode) {
      hideTooltip();
      button.remove();
      return;
    }
    if (button.parentNode !== anchor.parentNode || button.nextSibling !== anchor) {
      anchor.parentNode.insertBefore(button, anchor);
    }
    matchNativeGeometry(anchor);
    button.hidden = false;
    render();
  }

  async function requestToggle() {
    if (disposed || busy || !session || !button.isConnected || button.hidden) return;
    const root = findPlayer(), anchor = findControl(root);
    if (!root || !anchor || !visibleWithPlayer(root, anchor)) return;
    const next = !enabled;
    const currentSession = session;
    const request = ++requestRevision;
    const stateAtStart = stateRevision;
    busy = true;
    failed = false;
    failure = undefined;
    render();
    try {
      await onToggle(next);
      if (disposed || request !== requestRevision || session !== currentSession) return;
      if (stateRevision === stateAtStart) {
        enabled = next;
        stateRevision++;
      }
    } catch (error) {
      if (!disposed && request === requestRevision && session === currentSession) {
        failed = true;
        failure = error;
      }
    } finally {
      if (!disposed && request === requestRevision && session === currentSession) {
        busy = false;
        render();
      }
    }
  }

  const stopPropagation = (event: Event) => event.stopPropagation();
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend', 'keydown', 'keyup', 'keypress']) {
    button.addEventListener(type, stopPropagation);
  }
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    if (event.isTrusted) void requestToggle();
  });
  button.addEventListener('mouseenter', () => { hovered = true; showTooltip(); });
  button.addEventListener('mouseleave', () => { hovered = false; hideTooltip(); });
  button.addEventListener('focus', showTooltip);
  button.addEventListener('blur', () => { if (!hovered) hideTooltip(); });
  button.addEventListener('keydown', event => { if (event.key === 'Escape') hideTooltip(); });

  const observer = new MutationObserver(reconcile);
  const onFullscreenChange = () => {
    hideTooltip();
    if (!document.fullscreenElement) {
      failed = false;
      failure = undefined;
      render();
    }
    reconcile();
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('scroll', hideTooltip, true);
  const unsubscribeLocale = onLocaleChange(render);
  render();
  refreshShortcut();

  return {
    update(nextEnabled: boolean, nextSession: string) {
      if (disposed) return;
      const normalizedSession = typeof nextSession === 'string' ? nextSession : '';
      if (session !== normalizedSession) {
        session = normalizedSession;
        requestRevision++;
        stateRevision++;
        busy = false;
        failed = false;
        failure = undefined;
      }
      if (enabled !== nextEnabled) {
        enabled = nextEnabled;
        stateRevision++;
        failed = false;
        failure = undefined;
      }
      render();
      reconcile();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      requestRevision++;
      observer.disconnect();
      observedRegion = null;
      observedParent = null;
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('scroll', hideTooltip, true);
      unsubscribeLocale();
      hideTooltip();
      button.remove();
    },
  };
}

