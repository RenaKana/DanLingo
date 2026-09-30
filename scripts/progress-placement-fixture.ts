// Local layout fixture using the real progress component; no provider or background requests.
import { createProgress } from '../src/ui/progress.ts';
import { DEFAULT_SETTINGS } from '../src/core/config.ts';
import type { SchedulerStats } from '../src/core/scheduler.ts';
import type { Settings } from '../src/core/types.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const column = $('grid-left');
const banner = $('festival-main-panel');
const shell = $('fixture-shell');
const measurements = $('measurements');
const settings: Settings = { ...DEFAULT_SETTINGS, enabled: true, displayMode: 'translated' };
const stats: SchedulerStats = { candidates: 24, total: 15, filtered: 3, eligibilityUnknown: 2,
  effectiveScope: 'window', displayState: 'visible', skipped: { special: 1, language: 1, emoticon: 0 },
  messages: 10, translated: 7, cacheHits: 2, queued: 2, inflight: 1, failed: 0, expired: 0,
  nearTotal: 5, nearPrepared: 4, sourceComplete: true };
const progress = createProgress(async () => {}, () => {});
let mode: 'festival' | 'normal' = 'festival';
let sequence = 0;
let player: HTMLElement | null = null;
let originalInlineStyles: string[] = [];

function renderPlayer(next: 'festival' | 'normal') {
  player?.remove();
  mode = next;
  sequence++;
  const stage = document.createElement('div');
  if (mode === 'festival') {
    stage.className = 'video-player-box';
    stage.innerHTML = '<div class="festival-video-player"><div id="bilibili-player"><div class="bpx-docker"><div class="bpx-player-container"><video playsinline muted></video><div class="video-scene"><strong>活动页播放器</strong><span>固定高度外盒 · 模拟视频</span></div></div></div></div></div>';
  } else {
    stage.id = 'playerWrap';
    stage.innerHTML = '<div class="bpx-player-container"><video playsinline muted></video><div class="video-scene"><strong>普通视频播放器</strong><span>原位挂载 · 模拟视频</span></div></div>';
  }
  const surface = stage.querySelector<HTMLElement>('.bpx-player-container')!;
  surface.dataset.danlingoPlayer = `fixture-${sequence}`;
  column.insertBefore(stage, banner);
  player = stage;
  originalInlineStyles = [stage, ...stage.querySelectorAll<HTMLElement>('*')].map(node => node.getAttribute('style') ?? '');
  progress.attach(`fixture-${sequence}`, `fixture-resource-${sequence}`, 'bilibili');
  progress.update(settings, stats, '', true);
  requestAnimationFrame(renderMeasurements);
}

const bounds = (node: Element | null) => {
  if (!node) return '—';
  const rect = node.getBoundingClientRect();
  return `top ${Math.round(rect.top)}, bottom ${Math.round(rect.bottom)}, height ${Math.round(rect.height)}`;
};

function renderMeasurements() {
  const host = $('danlingo-progress');
  const video = player?.querySelector('video') ?? null;
  const details = host?.shadowRoot?.getElementById('progress-details') as HTMLDetailsElement | null;
  const siteNodes = player ? [player, ...player.querySelectorAll<HTMLElement>('*')] : [];
  const inlineUnchanged = siteNodes.every((node, index) => (node.getAttribute('style') ?? '') === originalInlineStyles[index]);
  const videoRect = video?.getBoundingClientRect();
  const playerRect = player?.getBoundingClientRect();
  const panelRect = host?.getBoundingClientRect();
  const bannerRect = banner.getBoundingClientRect();
  const belowVideo = !!panelRect && !!videoRect && panelRect.top >= videoRect.bottom - 1;
  const afterBox = !!panelRect && !!playerRect && panelRect.top >= playerRect.bottom - 1;
  const beforeBanner = !!panelRect && panelRect.bottom <= bannerRect.top + 1;
  $('mode-festival').setAttribute('aria-pressed', String(mode === 'festival'));
  $('mode-normal').setAttribute('aria-pressed', String(mode === 'normal'));
  $('toggle-translation').textContent = settings.displayMode === 'original' ? '显示翻译' : '隐藏翻译';
  measurements.textContent = `布局 ${mode === 'festival' ? '活动页' : '普通视频'} · 进度 ${details?.open ? '展开' : '收起'} · 翻译 ${settings.displayMode === 'original' ? '隐藏' : '显示'} · ${document.fullscreenElement ? '全屏' : '普通窗口'}\n`
    + `播放器外盒 ${bounds(player)}\n视频 ${bounds(video)}\n进度 ${bounds(host)} · hidden ${host?.hidden ?? true}\n广告 ${bounds(banner)}\n`
    + `挂载父级 ${host?.parentElement?.className || '无'} · 视频下方 ${belowVideo} · 外盒之后 ${afterBox} · 广告之前 ${beforeBanner} · 网站内联样式未变 ${inlineUnchanged}`;
}

$('mode-festival').addEventListener('click', () => renderPlayer('festival'));
$('mode-normal').addEventListener('click', () => renderPlayer('normal'));
$('replace-player').addEventListener('click', () => renderPlayer(mode));
$('toggle-translation').addEventListener('click', () => {
  settings.displayMode = settings.displayMode === 'original' ? 'translated' : 'original';
  progress.update(settings, stats, '', true);
  requestAnimationFrame(renderMeasurements);
});
$('toggle-fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void shell.requestFullscreen();
});
document.addEventListener('fullscreenchange', () => requestAnimationFrame(renderMeasurements));
document.addEventListener('click', event => {
  if ((event.target as Element).closest('#danlingo-progress')) requestAnimationFrame(renderMeasurements);
});
const observer = new ResizeObserver(() => requestAnimationFrame(renderMeasurements));
observer.observe(column);
renderPlayer('festival');
