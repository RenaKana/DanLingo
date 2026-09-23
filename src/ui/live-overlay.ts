import type { Settings } from '../core/types.ts';
import type { LiveRelease } from '../core/live-scheduler.ts';

interface ActiveComment { element: HTMLElement; animation: Animation; width: number; startedAt: number; speed: number; lane: number; authorId?: string }
/** No innerHTML for message data; all video interactions pass through the host. */
export function createLiveOverlay(initial: Settings) {
  let settings = initial;
  let player: HTMLElement | null = null;
  let width = 0, height = 0, oldPosition: string | null = null;
  const host = document.createElement('div'); host.id = 'danlingo-live-overlay'; host.setAttribute('aria-hidden', 'true');
  Object.assign(host.style, { position: 'absolute', inset: '0', overflow: 'hidden', pointerEvents: 'none', zIndex: '30', contain: 'layout style paint' });
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = ':host{pointer-events:none!important}span{position:absolute;left:0;top:0;white-space:pre;pointer-events:none;user-select:none;font-family:Arial,"Microsoft YaHei",sans-serif;font-weight:600;line-height:1.3;color:white;text-shadow:0 1px 2px #000,1px 0 1px #000,-1px 0 1px #000;will-change:transform;unicode-bidi:plaintext}';
  root.append(style);
  const comments = new Map<string, ActiveComment>();
  function remove(id: string) {
    const row = comments.get(id); if (!row) return;
    comments.delete(id); row.animation.cancel(); row.element.remove();
  }
  function clear() { for (const id of comments.keys()) remove(id); }
  function resize() {
    if (!player) return;
    const box = player.getBoundingClientRect();
    if (Math.abs(box.width - width) > 1 || Math.abs(box.height - height) > 1) clear();
    width = box.width; height = box.height;
  }
  const observer = new ResizeObserver(resize);
  function detach() {
    observer.disconnect(); clear(); host.remove();
    if (player && oldPosition !== null && player.style.position === 'relative') player.style.position = oldPosition;
    player = null; oldPosition = null; width = height = 0;
  }
  return {
    attach(next: HTMLElement | null) {
      if (player === next && host.isConnected) return;
      detach();
      if (!next || !next.querySelector('video')) return;
      player = next;
      if (getComputedStyle(player).position === 'static') { oldPosition = player.style.position; player.style.position = 'relative'; }
      player.append(host); observer.observe(player); resize();
    },
    configure(next: Settings) {
      if (settings.liveSpeed !== next.liveSpeed || settings.liveFontSize !== next.liveFontSize || settings.liveDensity !== next.liveDensity) clear();
      settings = next; host.style.opacity = String(settings.liveOpacity);
    },
    release(event: LiveRelease): boolean {
      if (!player?.isConnected || !width || !height || comments.has(event.source.id) || comments.size >= 120 || document.hidden) return false;
      const element = document.createElement('span'); element.textContent = event.text; element.style.fontSize = `${settings.liveFontSize}px`;
      // Stable, non-visible identity lets acceptance tools correlate same-text events without guessing.
      element.dataset.sourceEventId = event.source.id;
      element.dataset.translationStatus = event.translated ? 'translated' : 'original';
      element.dataset.displayAt = String(performance.timeOrigin + event.displayAt);
      if (event.preparedAt !== undefined) element.dataset.preparedAt = String(performance.timeOrigin + event.preparedAt);
      element.style.visibility = 'hidden'; root.append(element);
      // Text is measured after translation, before choosing a lane or animation path.
      const measured = element.getBoundingClientRect();
      if (!measured.width || measured.width > Math.max(width * 3, 1600)) { element.remove(); return false; }
      const lineHeight = Math.ceil(settings.liveFontSize * 1.4), available = Math.min(settings.liveDensity, Math.floor((height - 60) / lineHeight));
      const now = performance.now(), speed = settings.liveSpeed;
      let lane = -1;
      for (let i = 0; i < available; i++) {
        // All comments share a fixed configured speed; after the previous tail enters there is no catch-up collision.
        if ([...comments.values()].filter(row => row.lane === i).every(row => (now - row.startedAt) * row.speed / 1000 >= row.width + 30)) { lane = i; break; }
      }
      if (lane < 0) { element.remove(); return false; }
      element.style.top = `${12 + lane * lineHeight}px`; element.style.visibility = 'visible';
      const animation = element.animate([{ transform: `translateX(${width}px)` }, { transform: `translateX(${-measured.width}px)` }],
        { duration: (width + measured.width) / speed * 1000, easing: 'linear', fill: 'forwards' });
      comments.set(event.source.id, { element, animation, width: measured.width, startedAt: now, speed, lane, authorId: event.source.authorId });
      animation.onfinish = () => remove(event.source.id);
      return true;
    },
    remove(ids: string[]) { ids.forEach(remove); },
    removeAuthor(authorId: string) { for (const [id, row] of comments) if (row.authorId === authorId) remove(id); },
    clear, dispose: detach,
  };
}
