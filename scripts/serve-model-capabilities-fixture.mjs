// Loopback-only settings-page fixture. No extension storage, credentials or provider requests.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length > 2 || args.length && (args[0] !== '--port' || !/^\d{1,5}$/.test(args[1] ?? ''))) {
  throw new Error('Usage: node scripts/serve-model-capabilities-fixture.mjs [--port 0..65535]');
}
const port = args.length ? Number(args[1]) : 0;
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');

const projectRequire = createRequire(import.meta.resolve('wxt'));
const { build } = await import(pathToFileURL(projectRequire.resolve('vite')).href);
const result = await build({
  configFile: false, root, publicDir: false, logLevel: 'error',
  plugins: [{
    name: 'model-capabilities-browser-fixture',
    enforce: 'pre',
    resolveId(source) { if (source === 'wxt/browser') return '\0fixture-browser'; },
    load(id) { if (id === '\0fixture-browser') return 'export const browser = globalThis.__fixtureBrowser;'; },
  }],
  build: { write: false, emptyOutDir: false, copyPublicDir: false, minify: false,
    sourcemap: false, target: 'es2022', rollupOptions: { input: resolve(root, 'entrypoints/options/index.html') } },
});
const files = new Map();
for (const item of Array.isArray(result) ? result.flatMap(part => part.output ?? []) : result.output ?? []) {
  files.set('/' + item.fileName, item.type === 'chunk' ? item.code : item.source);
}
const htmlPath = [...files.keys()].find(name => name.endsWith('/options/index.html'));
if (!htmlPath) throw new Error('Options HTML missing from fixture bundle');

const setup = String.raw`
(() => {
  const actions = new URL(location.href).searchParams.has('model-actions');
  const key = 'danlingo-model-capabilities-fixture' + (actions ? '-actions' : '');
  const initial = { endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-next-experimental',
    profile: 'deepseek', reasoningProfileOverride: 'auto', thinkingEffort: 'off',
    superChatThinkingEffort: 'inherit', backend: actions ? 'local' : 'online', allowLocalHttp: false,
    ...(actions ? { localModelId: 'fixture-local-model', bilibiliOwnedRelease: true,
      bilibiliHybrid: { enabled: true, profiles: [], adaptive: false, onlineStreaming: false } } : {}) };
  const localModel = { id: 'fixture-local-model', name: 'Local translation fixture', files: ['fixture.gguf'],
    bytes: 1000000, architecture: 'hunyuan-dense', quantization: 'Q4', tokenizer: 'fixture', template: true,
    importedAt: 1, availability: 'ready', metadataVersion: 1, metadataComplete: true };
  const stored = JSON.parse(sessionStorage.getItem(key) || '{}');
  let settings = { ...initial, ...stored.settings };
  let catalog = stored.catalog;
  let catalogScope = stored.catalogScope;
  let keyPresent = true;
  let savedKey = 'stored-fixture-key';
  const listeners = new Set();
  const local = {};
  const scope = message => JSON.stringify([message.settings?.endpoint, message.apiKey || savedKey]);
  const persist = () => sessionStorage.setItem(key, JSON.stringify({ settings, catalog, catalogScope }));
  const overview = () => ({ ok: true, settings, hasOnlineKey: keyPresent, hasKey: keyPresent,
    remembered: true, cache: { entries: 0, bytes: 0 } });
  const actionLog = [];
  const record = message => {
    if (!actions || !['models', 'test-model', 'save'].includes(message.type)) return;
    actionLog.push(message.type + ': ' + message.settings.backend + ' / ' +
      (message.settings.backend === 'local' ? message.settings.localModelId : message.settings.model));
    let log = document.getElementById('fixture-action-log');
    if (!log) { log = document.createElement('pre'); log.id = 'fixture-action-log'; document.body.append(log); }
    log.textContent = '本机模拟调用（无真实服务）\n' + actionLog.join('\n') +
      '\n已保存翻译后端: ' + settings.backend + ' / 本地模型: ' + settings.localModelId;
  };
  window.__fixtureBrowser = {
    i18n: { getUILanguage: () => 'zh-CN' },
    storage: { local: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(name => [name, local[name]])),
      set: async value => Object.assign(local, value),
    }, onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } },
    permissions: { contains: async () => true, request: async () => true },
    commands: { getAll: async () => [] },
    tabs: { create: async () => ({}) },
    runtime: {
      getURL: name => new URL(name, location.href).href,
      onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
      sendMessage: async message => {
        record(message);
        switch (message.type) {
          case 'settings-ui-connect': return { ok: true };
          case 'overview': return overview();
          case 'model-catalog': return { ok: true, catalog: scope(message) === catalogScope ? catalog : undefined };
          case 'models': {
            const fetchedAt = Date.now();
            catalog = { models: ['deepseek-next-experimental', 'unlisted-model'], fetchedAt,
              capabilities: { 'deepseek-next-experimental': { supportedLevels: ['low', 'high', 'max'], defaultLevel: 'low' } } };
            catalogScope = scope(message);
            persist();
            return { ok: true, ...catalog };
          }
          case 'save': {
            const { modelReasoning, ...saved } = message.settings;
            if (message.apiKey) savedKey = message.apiKey;
            settings = saved; persist(); return overview();
          }
          case 'local-control': return { ok: true, models: actions ? [localModel] : [], directories: [],
            state: actions ? { phase: 'ready', generation: 1, model: localModel, active: 0, queued: 0, inferenceCalls: 0 } : { phase: 'idle' } };
          case 'test-model': return { ok: true,
            model: message.settings.backend === 'local' ? localModel.name : message.settings.model,
            sourceText: message.text || '这个视频很有趣', text: 'この動画は面白いです', elapsedMs: 120,
            targetLanguage: message.settings.targetLanguage, verification: 'protocol-only',
            promptMode: message.settings.backend === 'local' ? 'hy-mt' : 'json',
            ...(message.settings.backend === 'local' ? { local: { queueMs: 0, inferenceMs: 120 } } : {}) };
          case 'hybrid-capacity': return { ok: true, identity: 'fixture-capacity', recommendation: null };
          case 'service-history': return { ok: true, addresses: [] };
          case 'performance-history': return { ok: true, records: [] };
          case 'bilibili-user-filter-status': return { ok: true, sources: [] };
          case 'online-budget-status': return { ok: true };
          default: return { ok: true };
        }
      },
    },
  };
})();`;

const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  let body = files.get(path === '/' ? htmlPath : path);
  if (path === '/' && typeof body === 'string') body = body.replace('</head>', `<script>${setup}</script></head>`);
  const type = path === '/' || path.endsWith('.html') ? 'text/html; charset=utf-8'
    : path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
  response.writeHead(body === undefined ? 404 : 200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(body ?? 'Not found');
});
await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done); });
console.log(`Model capabilities settings fixture: http://127.0.0.1:${server.address().port}/`);
