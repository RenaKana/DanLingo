// Loopback-only visual fixture for the video translation control.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(root, 'scripts/bilibili-toggle-fixture.ts');
const args = process.argv.slice(2);
if (args.length > 2 || args[0] && args[0] !== '--port' || args[0] && !/^\d{1,5}$/.test(args[1] ?? '')) {
  throw new Error('Usage: node scripts/serve-bilibili-toggle-fixture.mjs [--port 0..65535]');
}
const port = args.length ? Number(args[1]) : 0;
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');

const projectRequire = createRequire(import.meta.resolve('wxt'));
const { build } = await import(pathToFileURL(projectRequire.resolve('vite')).href);
const result = await build({
  configFile: false, root, publicDir: false, logLevel: 'error',
  build: { write: false, emptyOutDir: false, copyPublicDir: false, minify: false,
    sourcemap: false, target: 'es2022', rollupOptions: {
      input: entry, output: { format: 'iife', name: 'BilibiliToggleFixture', entryFileNames: 'fixture.js' },
    } },
});
const outputs = Array.isArray(result) ? result.flatMap(item => item.output ?? []) : result.output ?? [];
const bundle = outputs.find(item => item.type === 'chunk' && item.isEntry)?.code;
if (!bundle) throw new Error('Fixture bundle missing');

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bilibili 翻译开关尺寸夹具</title>
<style>
  *{box-sizing:border-box} [hidden]{display:none!important}
  body{margin:0;background:#f4f6f8;color:#24292d;font:14px/1.5 Arial,"Microsoft YaHei",sans-serif}
  #fixture-shell{max-width:1100px;margin:auto;padding:18px 24px}
  h1{font-size:18px;margin:0 0 10px} p{margin:10px 0;color:#4d5960}
  .fixture-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:8px 0 14px}
  .fixture-actions button{font:inherit;border:1px solid #b4bfc7;background:#fff;border-radius:4px;padding:6px 12px;cursor:pointer}
  .fixture-actions button[aria-pressed=true]{border-color:#1689b5;background:#dff4fb}
  #playerWrap{position:relative;width:100%;height:440px;background:#151d2a;color:#f4f4f4;overflow:hidden}
  .video-scene{height:100%;padding:24px;background:linear-gradient(145deg,#27384d,#121a28)}
  .video-scene strong{font-size:19px} .video-scene small{color:#b5c8d7}
  .player-toolbar{position:absolute;left:0;right:0;bottom:0;min-height:60px;background:#f4f5f7;color:#61666d;display:flex;align-items:center;padding:0 18px}
  .bpx-player-dm-root{display:flex;align-items:center;min-height:46px}
  .bpx-player-dm-switch,.bpx-player-dm-setting{box-sizing:border-box;display:flex;flex:none;align-items:center;justify-content:center;width:30px;height:30px;margin:0 12px 0 0;padding:0;border:0;background:transparent;color:#61666d;fill:#61666d;cursor:pointer}
  .bpx-player-dm-switch svg{display:block;width:30px;height:30px}
  .bpx-player-dm-setting{height:46px}
  .bpx-common-svg-icon{display:block;width:30px;height:24px}
  .bpx-player-dm-setting svg{display:block;width:30px;height:24px}
  .fixture-festival .bpx-player-dm-switch{fill:rgb(189,147,59);color:rgb(189,147,59)}
  .fixture-festival .bpx-player-dm-switch .bui-switch-body{display:flex;align-items:center;width:30px;height:20px;border-radius:10px;background:#4b5764}
  .fixture-festival .bpx-player-dm-switch .bui-switch-dot{display:flex;align-items:center;justify-content:center;width:16px;height:16px;margin-left:2px;border-radius:50%;background:#fff}
  .fixture-festival .bpx-player-dm-switch svg{width:10px;height:10px}
  #fixture-shell:fullscreen{max-width:none;width:100%;height:100%;padding:18px 24px;background:#131923;color:#fff}
  #fixture-shell:fullscreen #playerWrap{height:calc(100% - 165px)}
  #fixture-shell:fullscreen .player-toolbar{background:#101722;color:rgba(255,255,255,.9)}
  #fixture-shell:fullscreen .bpx-player-dm-switch,#fixture-shell:fullscreen .bpx-player-dm-setting{color:rgba(255,255,255,.9);fill:rgba(255,255,255,.9)}
  #fixture-shell:fullscreen .fixture-festival .bpx-player-dm-switch{fill:rgb(189,147,59);color:rgb(189,147,59)}
  #fixture-shell:fullscreen p{color:#cad5dd}
  #fixture-shell:fullscreen .fixture-actions button{color:#24292d}
  #measurements{font-variant-numeric:tabular-nums;white-space:pre-wrap}
  @media(max-width:600px){#fixture-shell{padding:12px}#playerWrap{height:320px}.video-scene{padding:15px}}
</style>
<section id="fixture-shell">
  <h1>Bilibili 翻译开关本机夹具</h1>
  <div class="fixture-actions">
    <button id="mode-normal" type="button">普通视频控件</button>
    <button id="mode-festival" type="button">活动页胶囊控件</button>
    <button id="enter-fullscreen" type="button">进入全屏</button>
    <button id="exit-fullscreen" type="button">退出全屏</button>
  </div>
  <div id="playerWrap" class="fixture-normal">
    <video hidden></video><div class="video-scene"><strong>模拟播放器</strong><br><small>观察底部翻译 TV 与弹幕及设置控件</small></div>
    <div class="player-toolbar"><div class="bpx-player-dm-root" id="native-controls">
      <button class="bpx-player-dm-switch" aria-label="弹幕开关" type="button"></button>
      <button class="bpx-player-dm-setting" aria-label="弹幕设置" type="button">
        <span class="bpx-common-svg-icon"><svg viewBox="0 0 30 24" aria-hidden="true"><path fill="currentColor" d="M6 3h18v3H6zm0 7h18v3H6zm0 7h18v3H6z"/></svg></span>
      </button>
    </div></div>
    <div data-danlingo-player="fixture-session" hidden></div>
  </div>
  <p id="measurements" aria-live="polite"></p>
  <p>本机仅调用开关的显示模块；翻译回调只计数，没有扩展后台、网站或模型请求。</p>
</section><script src="/fixture.js"></script></html>`;

const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const resource = path === '/' ? { body: html, type: 'text/html; charset=utf-8' }
    : path === '/fixture.js' ? { body: bundle, type: 'text/javascript; charset=utf-8' } : null;
  response.writeHead(resource ? 200 : 404, { 'Content-Type': resource?.type ?? 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'" });
  response.end(resource?.body ?? 'Not found');
});
await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done); });
console.log(`Bilibili toggle fixture: http://127.0.0.1:${server.address().port}/`);
