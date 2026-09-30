// Serves only an in-memory source bundle on loopback for a manual layout check.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(root, 'scripts/progress-placement-fixture.ts');
const args = process.argv.slice(2);
if (args.length > 2 || args[0] && args[0] !== '--port' || args[0] && !/^\d{1,5}$/.test(args[1] ?? '')) {
  throw new Error('Usage: node scripts/serve-progress-placement-fixture.mjs [--port 0..65535]');
}
const port = args.length ? Number(args[1]) : 0;
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');

const projectRequire = createRequire(import.meta.resolve('wxt'));
const { build } = await import(pathToFileURL(projectRequire.resolve('vite')).href);
const result = await build({
  configFile: false, root, publicDir: false, logLevel: 'error',
  plugins: [{
    name: 'progress-placement-fixture-browser',
    enforce: 'pre',
    resolveId(source) { if (source === 'wxt/browser') return '\0fixture-browser'; },
    load(id) { if (id === '\0fixture-browser') return `export const browser = {
      i18n: { getUILanguage: () => 'zh-CN' }, storage: {
        local: { get: async () => ({}), set: async () => {} },
        onChanged: { addListener() {}, removeListener() {} }
      }
    };`; },
  }],
  build: { write: false, emptyOutDir: false, copyPublicDir: false, minify: false,
    sourcemap: false, target: 'es2022', rollupOptions: {
      input: entry, output: { format: 'iife', name: 'ProgressPlacementFixture', entryFileNames: 'fixture.js' },
    } },
});
const outputs = Array.isArray(result) ? result.flatMap(item => item.output ?? []) : result.output ?? [];
const bundle = outputs.find(item => item.type === 'chunk' && item.isEntry)?.code;
if (!bundle) throw new Error('Fixture bundle missing');

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>进度挂载位置夹具</title>
<style>
  *{box-sizing:border-box}[hidden]{display:none!important}
  body{margin:0;background:#f5f7f9;color:#273238;font:14px/1.5 Arial,"Microsoft YaHei",sans-serif}
  #fixture-shell{max-width:1100px;margin:auto;padding:18px 24px;min-width:0}
  h1{font-size:18px;margin:0 0 8px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}
  button{font:inherit;border:1px solid #bac5ce;border-radius:4px;background:white;padding:5px 10px;cursor:pointer}
  button[aria-pressed=true]{border-color:#40779e;background:#e8f3fa}
  .grid-left{display:block;width:100%;min-width:0}
  .video-player-box,.festival-video-player,#bilibili-player,.bpx-docker{height:556px;width:100%}
  .video-player-box,#playerWrap{position:relative;background:#14222e;overflow:hidden}
  #playerWrap{height:420px;width:100%}
  .bpx-player-container{height:100%;position:relative;overflow:hidden}
  video{display:block;width:100%;height:100%;background:#162b3a}
  .video-scene{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;
    pointer-events:none;color:#eff5f7;background:linear-gradient(140deg,#1d4152,#24303f)}
  .video-scene strong{font-size:24px}.video-scene span{color:#b9cad3}
  #festival-main-panel{margin-top:12px;padding:18px;background:#fff;border-top:4px solid #d7a74c;min-height:100px}
  #festival-main-panel h2{margin:0 0 6px;font-size:16px}#festival-main-panel p{margin:0}
  #following-content{margin-top:14px;min-height:150px;background:#e7edf1;padding:18px}
  #measurements{white-space:pre-wrap;font:12px/1.65 ui-monospace,Consolas,monospace;background:white;padding:12px;border:1px solid #dce3e9;overflow-wrap:anywhere}
  #fixture-shell:fullscreen{max-width:none;width:100%;height:100%;overflow:auto;background:#f5f7f9}
  @media(max-width:600px){#fixture-shell{padding:12px}.video-player-box,.festival-video-player,#bilibili-player,.bpx-docker{height:556px}}
</style>
<main id="fixture-shell"><h1>进度面板挂载位置</h1>
<div class="actions"><button id="mode-festival" type="button">活动页</button><button id="mode-normal" type="button">普通视频</button>
<button id="replace-player" type="button">替换播放器</button><button id="toggle-translation" type="button">隐藏翻译</button>
<button id="toggle-fullscreen" type="button">切换全屏</button></div>
<section id="grid-left" class="grid-left"><section id="festival-main-panel"><h2>活动页广告区域</h2><p>与播放器外盒同级，位置应随进度面板展开而下移。</p></section>
<section id="following-content">后续正文区域</section></section>
<pre id="measurements" aria-live="polite"></pre></main><script src="/fixture.js"></script></html>`;

const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const resource = path === '/' ? { body: html, type: 'text/html; charset=utf-8' }
    : path === '/fixture.js' ? { body: bundle, type: 'text/javascript; charset=utf-8' } : null;
  response.writeHead(resource ? 200 : 404, { 'Content-Type': resource?.type ?? 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'" });
  response.end(resource?.body ?? 'Not found');
});
await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done); });
console.log(`Progress placement fixture: http://127.0.0.1:${server.address().port}/`);
