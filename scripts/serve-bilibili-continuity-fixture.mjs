// Loopback-only visual harness for the owned-release fullscreen continuity path.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(root, 'scripts/bilibili-continuity-fixture.ts');
const videoModule = resolve(root, 'src/platforms/bilibili/video.ts').replaceAll('\\', '/');
const args = process.argv.slice(2);
if (args.length > 2 || args[0] && args[0] !== '--port' || args[0] && !/^\d{1,5}$/.test(args[1] ?? '')) {
  throw new Error('Usage: node scripts/serve-bilibili-continuity-fixture.mjs [--port 0..65535]');
}
const port = args.length ? Number(args[1]) : 0;
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');

const projectRequire = createRequire(import.meta.resolve('wxt'));
const { build } = await import(pathToFileURL(projectRequire.resolve('vite')).href);
const result = await build({
  configFile: false, root, publicDir: false, logLevel: 'error',
  plugins: [{
    name: 'bilibili-continuity-fixture-url-only',
    enforce: 'pre',
    resolveId(source) { if (source === 'wxt/browser') return '\0fixture-browser'; },
    load(id) { if (id === '\0fixture-browser') return `export const browser = {
      i18n: { getUILanguage: () => 'zh-CN' }, storage: {
        local: { get: async () => ({}), set: async () => {} },
        onChanged: { addListener() {}, removeListener() {} }
      }
    };`; },
    transform(source, id) {
      if (id.replaceAll('\\', '/').split('?')[0] !== videoModule) return null;
      // The real localhost address cannot pass production Bilibili URL matching.
      // This transform is confined to the in-memory test bundle, not product source.
      return source.replaceAll('(globalThis as any).location?.href ?? \'\'',
        '(globalThis as any).__DL_FIXTURE_BILIBILI_HREF__ ?? (globalThis as any).location?.href ?? \'\'')
        .replace('const href = String(win.location?.href ?? \'\');',
          'const href = String((globalThis as any).__DL_FIXTURE_BILIBILI_HREF__ ?? win.location?.href ?? \'\');');
    },
  }],
  build: { write: false, emptyOutDir: false, copyPublicDir: false, minify: false,
    sourcemap: false, target: 'es2022', rollupOptions: {
      input: entry, output: { format: 'iife', name: 'BilibiliContinuityFixture', entryFileNames: 'fixture.js' },
    } },
});
const outputs = Array.isArray(result) ? result.flatMap(item => item.output ?? []) : result.output ?? [];
const bundle = outputs.find(item => item.type === 'chunk' && item.isEntry)?.code;
if (!bundle || !bundle.includes('__DL_FIXTURE_BILIBILI_HREF__')) throw new Error('Fixture URL substitution missing');

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bilibili owned-release 全屏连续性夹具</title>
<style>
  :root{font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:#1d292d;background:#f5f7f6}
  *{box-sizing:border-box} [hidden]{display:none!important} body{margin:0} main{max-width:1240px;margin:auto;padding:20px;display:grid;grid-template-columns:minmax(0,1fr) 310px;gap:20px}
  h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:0 0 10px} p{margin:0 0 12px;color:#52626a}
  #fixture-shell{min-width:0} .toolbar{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
  button{border:1px solid #bcc9c8;background:#fff;color:#18282a;font:inherit;padding:8px 12px;border-radius:5px;cursor:pointer}
  button:hover{background:#e9f2ef} button:disabled{opacity:.45;cursor:default}
  #playerWrap{position:relative;background:#16242a;color:#fff;border:1px solid #4a646a;min-height:280px;max-width:500px;overflow:hidden}
  #playerWrap.wide{max-width:100%} #playerWrap .screen{min-height:280px;height:100%;padding:18px;background:linear-gradient(120deg,#13252a,#24393b)}
  #playerWrap .screen strong{font-size:16px} #playerWrap .screen span{color:#a6c7c5}
  #screen-danmaku{position:absolute;top:42%;left:20px;right:20px;display:grid;gap:10px;pointer-events:none}
  #screen-danmaku div{width:max-content;max-width:100%;font-size:22px;font-weight:600;text-shadow:0 1px 3px #000,0 0 8px #000}
  aside{border-left:1px solid #d4dedb;padding-left:18px;min-width:0} dl{display:grid;grid-template-columns:145px 1fr;gap:6px;margin:0 0 16px}
  dt{color:#52626a} dd{margin:0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
  table{border-collapse:collapse;width:100%;margin:14px 0;background:#fff}th,td{border-bottom:1px solid #d4dedb;text-align:left;padding:8px;vertical-align:top}
  th{color:#455c5c;font-size:12px} .pass{color:#116b3b} .fail{color:#a52624} .pending{color:#576b6d}
  #checks div{padding:4px 0;border-bottom:1px solid #e0e6e3} #route-checks{font-size:12px;white-space:pre-wrap}
  #fixture-shell:fullscreen{max-width:none;width:100%;height:100%;padding:22px;background:#f5f7f6;overflow:auto}
  #fixture-shell:fullscreen #playerWrap{max-width:100%;height:min(55vh,720px)}
  @media(max-width:850px){main{display:block;padding:12px}aside{border-left:0;border-top:1px solid #d4dedb;margin-top:18px;padding:16px 0 0}dl{grid-template-columns:145px 1fr}}
</style>
<main><section id="fixture-shell">
<h1>Bilibili 全屏连续性</h1><p>本机假原生播放器 · 真实 owned-release 模块 · 两条模拟译文</p>
<div class="toolbar"><button id="enter-fullscreen">进入全屏</button><button id="exit-fullscreen">退出全屏</button>
<button id="repeat-resize">重复有效尺寸变化</button><button id="late-result">返回第二条译文</button>
<button id="before-deadline">推进至原截止前</button><button id="consume">原窗口消费</button><button id="repeat-consume">消费后重复 resize</button></div>
<div id="pause-controls" class="toolbar" hidden><button id="pause-result">返回暂停期间的模拟译文</button><button id="pause-hold">继续暂停 90 秒</button><button id="pause-resume">恢复并采用开头译文</button></div>
<div id="playerWrap" class="bpx-player-container"><video hidden></video><div class="screen"><strong>本地播放器</strong><br><span>视频时钟由按钮推进，弹幕在 native initRender 后显示</span><div id="screen-danmaku"></div></div></div>
<table aria-label="弹幕"><thead><tr><th>原文</th><th>译文</th><th>状态</th></tr></thead><tbody id="rows"></tbody></table>
<h2>断言</h2><div id="checks"></div>
</section><aside><h2>运行数据</h2><dl id="metrics"></dl><h2>路由解析</h2><pre id="route-checks"></pre><p>URL 仅在本夹具内替换为 B 站视频地址。没有请求模型，也没有验证真实 B 站页面、扩展或个人浏览器。</p></aside></main>
<script src="/fixture.js"></script></html>`;

const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const resource = path === '/' ? { body: html, type: 'text/html; charset=utf-8' }
    : path === '/fixture.js' ? { body: bundle, type: 'text/javascript; charset=utf-8' } : null;
  response.writeHead(resource ? 200 : 404, { 'Content-Type': resource?.type ?? 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'" });
  response.end(resource?.body ?? 'Not found');
});
await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done); });
console.log(`Bilibili continuity fixture: http://127.0.0.1:${server.address().port}/`);
