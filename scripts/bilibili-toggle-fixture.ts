import { mountBilibiliFullscreenToggle } from '../src/ui/bilibili-fullscreen-toggle.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const shell = $('fixture-shell');
const player = $('playerWrap');
const controls = $('native-controls');
const measurements = $('measurements');
let mode: 'normal' | 'festival' = 'normal';
let toggles = 0;
let nativeClicks = 0;
const mounted = mountBilibiliFullscreenToggle(async () => { toggles++; requestAnimationFrame(render); }, async () => 'Alt+T');

function nativeSwitch() {
  const button = document.createElement('button');
  button.className = 'bpx-player-dm-switch';
  button.type = 'button';
  button.setAttribute('aria-label', '弹幕开关');
  button.innerHTML = mode === 'festival'
    ? '<span class="bui-switch-body"><span class="bui-switch-dot"><svg viewBox="0 0 10 10" aria-hidden="true"><text x="0" y="9" fill="currentColor" font-size="10">弹</text></svg></span></span>'
    : '<svg viewBox="0 0 30 30" aria-hidden="true"><rect x="2" y="7" width="26" height="16" rx="8" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="11" cy="15" r="5" fill="currentColor"/></svg>';
  button.addEventListener('click', () => { nativeClicks++; render(); });
  return button;
}

function render() {
  const toggle = $('danlingo-fullscreen-toggle');
  const native = controls.querySelector<HTMLElement>('.bpx-player-dm-switch');
  const icon = Array.from(toggle?.children ?? []).find(element => getComputedStyle(element).display !== 'none') as HTMLElement | undefined;
  const size = (element?: HTMLElement | null) => {
    if (!element) return '无';
    const bounds = element.getBoundingClientRect();
    return `${Math.round(bounds.width)}×${Math.round(bounds.height)}`;
  };
  $('mode-normal').setAttribute('aria-pressed', String(mode === 'normal'));
  $('mode-festival').setAttribute('aria-pressed', String(mode === 'festival'));
  measurements.textContent = `模式 ${mode === 'festival' ? '活动页' : '普通视频'} · ${document.fullscreenElement ? '全屏' : '普通窗口'}\n`
    + `翻译按钮 ${size(toggle)} / TV 图标 ${size(icon)} · 弹幕按钮 ${size(native)} / 其 SVG ${size(native?.querySelector('svg'))}\n`
    + `翻译 ${toggle?.getAttribute('aria-pressed') === 'true' ? '开启' : '关闭'} · 翻译回调 ${toggles} 次 · 原生弹幕点击 ${nativeClicks} 次`;
}

function setMode(next: 'normal' | 'festival') {
  mode = next;
  player.classList.toggle('fixture-normal', mode === 'normal');
  player.classList.toggle('fixture-festival', mode === 'festival');
  controls.querySelector('.bpx-player-dm-switch')?.replaceWith(nativeSwitch());
  requestAnimationFrame(render);
}

$('mode-normal').addEventListener('click', () => setMode('normal'));
$('mode-festival').addEventListener('click', () => setMode('festival'));
$('enter-fullscreen').addEventListener('click', () => { if (!document.fullscreenElement) void shell.requestFullscreen(); });
$('exit-fullscreen').addEventListener('click', () => { if (document.fullscreenElement) void document.exitFullscreen(); });
document.addEventListener('fullscreenchange', () => requestAnimationFrame(render));
controls.querySelector('.bpx-player-dm-switch')?.replaceWith(nativeSwitch());
mounted.update(false, 'fixture-session');
render();
