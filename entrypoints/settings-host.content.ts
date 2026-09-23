import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { SETTINGS_HOST_ORIGINS } from '../src/core/settings-frame';

export default defineContentScript({
  matches: SETTINGS_HOST_ORIGINS.map(origin => origin + '/*'), runAt: 'document_start',
  main(ctx) {
    if (window.top !== window) return;
    const hostDocument = crypto.randomUUID();
    let host: HTMLDivElement | undefined, dialog: HTMLDialogElement | undefined, frame: HTMLIFrameElement | undefined;
    let token: string | undefined, previousFocus: Element | null = null;
    const close = () => { dialog?.close(); host?.remove(); host = dialog = frame = undefined; token = undefined; if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true }); };
    const open = (next: string) => {
      if (host && token === next) { frame?.focus(); return; }
      close(); token = next; previousFocus = document.activeElement;
      host = document.createElement('div'); host.dataset.danlingoSettings = '';
      const root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style'); style.textContent = ':host{all:initial}dialog{padding:0;border:1px solid #657083;border-radius:12px;width:min(1120px,calc(100vw - 24px));height:min(880px,calc(100dvh - 24px));max-width:none;max-height:none;overflow:hidden;background:#fff;box-shadow:0 20px 80px #0007}dialog::backdrop{background:#10182780}iframe{display:block;border:0;width:100%;height:100%;color-scheme:normal}';
      dialog = document.createElement('dialog'); dialog.setAttribute('aria-label', 'DanLingo 设置');
      frame = document.createElement('iframe'); frame.title = 'DanLingo 设置'; frame.allow = 'clipboard-write'; frame.src = browser.runtime.getURL('/options.html') + '?embedded=' + next;
      dialog.addEventListener('cancel', event => { event.preventDefault(); void browser.runtime.sendMessage({ type: 'settings-close-request', token, hostDocument }); });
      dialog.addEventListener('click', event => {
        if (!event.isTrusted || event.target !== dialog) return;
        const bounds = dialog!.getBoundingClientRect();
        if (event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom) return;
        void browser.runtime.sendMessage({ type: 'settings-close-request', token, hostDocument, save: true });
      });
      dialog.append(frame); root.append(style, dialog); (document.body ?? document.documentElement).append(host); dialog.showModal(); frame.focus();
    };
    const listener = (message: any, sender: { id?: string; tab?: unknown }) => {
      if (sender.id !== browser.runtime.id || sender.tab) return;
      if (message?.type === 'settings-host-probe') return Promise.resolve({ ok: true, hostDocument, token });
      if (message?.type === 'settings-host-open' && message.hostDocument === hostDocument && typeof message.token === 'string' && /^[a-f0-9-]{36}$/.test(message.token)) {
        open(message.token); return Promise.resolve({ ok: true });
      }
      if (message?.type === 'settings-host-close' && token === message.token && message.hostDocument === hostDocument) { close(); return Promise.resolve({ ok: true }); }
    };
    browser.runtime.onMessage.addListener(listener);
    window.addEventListener('pagehide', close);
    ctx.onInvalidated(() => { close(); browser.runtime.onMessage.removeListener(listener); window.removeEventListener('pagehide', close); });
  },
});
