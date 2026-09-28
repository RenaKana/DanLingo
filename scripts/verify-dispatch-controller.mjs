// Disposable browser fixture for the dispatch control page. Browser APIs, target
// video, background and model are mocked; only the loopback transport is real.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadPlaywright, browserLaunchOptions } from './browser-runtime.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT = resolve(ROOT, '.artifacts/bilibili-pretranslation-audit/dispatch-runner-20260926');
const report = { evidence: 'ISOLATED_CONTROLLER_SOURCE_FIXTURE', checks: [], screenshots: [], errors: [],
  limitations: ['The fixture substitutes a localhost origin for the extension-origin guard and mocks extension APIs and the target video.',
    'No personal browser, real provider, model inference or deployed-extension acceptance.'] };
await mkdir(ARTIFACT, { recursive: true });
const run = await mkdtemp(resolve(ARTIFACT, 'controller-fixture-'));
const extension = resolve(run, 'extension');
await mkdir(extension);
const screenshot = resolve(run, 'controller.png');
const token = randomBytes(32).toString('hex');
const pending = new Map(), queue = [];
let allowedOrigin = '', poll = null, serial = 0, hello = null, server, uiServer, context, page;
const check = (name, value) => { assert.ok(value, name); report.checks.push(name); console.log('PASS', name); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 10000) {
  const end = Date.now() + timeout;
  do { const value = await fn(); if (value) return value; await delay(40); } while (Date.now() < end);
  throw Error(`Timed out: ${label}`);
}
function reply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': allowedOrigin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
  res.end(JSON.stringify(data));
}
function deliver() {
  if (!poll || !queue.length) return;
  const response = poll; poll = null;
  reply(response, 200, queue.shift());
}
async function command(name, payload = {}) {
  const id = `fixture_${++serial}`;
  return new Promise((resolveCommand, rejectCommand) => {
    const timer = setTimeout(() => { pending.delete(id); rejectCommand(Error(`Command timed out: ${name}`)); }, 10000);
    pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
    queue.push({ id, command: name, payload }); deliver();
  });
}

async function bundleFixture() {
  // WXT's pinned Vite is the available source bundler in this pnpm workspace.
  const requireFromWxt = createRequire(await realpath(resolve(ROOT, 'node_modules/wxt/package.json')));
  const { build } = await import(pathToFileURL(requireFromWxt.resolve('vite')).href);
  const mockPath = resolve(extension, 'mock-browser.mjs');
  await writeFile(mockPath, 'export const browser = globalThis.__fixtureBrowser;\n');
  await build({ configFile: false, root: ROOT, logLevel: 'error',
    resolve: { alias: [{ find: 'wxt/browser', replacement: mockPath }] },
    define: { __DANLINGO_BUILD_ID__: JSON.stringify('fixture-build') },
    plugins: [{ name: 'fixture-origin', enforce: 'pre', transform(code, id) {
      if (id.replaceAll('\\', '/').endsWith('/entrypoints/dispatch-runner/main.ts')) {
        const old = "location.protocol !== 'chrome-extension:'";
        assert.ok(code.includes(old), 'Expected source origin guard');
        return code.replace(old, "location.protocol !== 'http:'");
      }
    } }, { name: 'fixture-css', enforce: 'pre', resolveId(id) {
      if (id.endsWith('/dispatch-runner/style.css')) return '\0fixture-css';
    }, load(id) { if (id === '\0fixture-css') return ''; } }],
    build: { outDir: extension, emptyOutDir: false, minify: false,
      lib: { entry: resolve(ROOT, 'entrypoints/dispatch-runner/main.ts'), formats: ['es'], fileName: 'runner' } } });
  const html = (await readFile(resolve(ROOT, 'entrypoints/dispatch-runner/index.html'), 'utf8'))
    .replace('./main.ts', './runner.js').replace('</head>', '<link rel="stylesheet" href="./style.css">\n</head>');
  await writeFile(resolve(extension, 'dispatch-runner.html'), html);
  await copyFile(resolve(ROOT, 'entrypoints/dispatch-runner/style.css'), resolve(extension, 'style.css'));
  await writeFile(resolve(extension, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {});\n');
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3,
    name: 'DanLingo Dispatch Controller Fixture', version: '0.4.14',
    background: { service_worker: 'background.js' }, permissions: ['storage', 'tabs'],
    host_permissions: ['http://127.0.0.1/*'] }));
}

function mockBrowserPage() {
  if (location.pathname !== '/dispatch-runner.html') return;
  const restored = JSON.parse(sessionStorage.getItem('dispatchFixtureReload') || 'null');
  const stores = restored?.stores ?? { local: {}, session: {} };
  const storage = area => ({
    async get(keys) { const src = stores[area];
      if (typeof keys === 'string') return { [keys]: src[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, src[key]]));
      return { ...src };
    },
    async set(data) { Object.assign(stores[area], data); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete stores[area][key]; },
  });
  const targetUrl = 'https://www.bilibili.com/video/BV1yvhW6sEzi/#danlingo-audit';
  const fixture = globalThis.__fixture = { permission: false, permissionRequests: [], removed: [],
    rpc: [], audit: [], watch: [], sentMessages: [], tab: restored?.tab ?? null,
    nextTabId: restored?.nextTabId ?? 101, prepareCount: 0, reloads: 0, localActive: 0,
    enabled: false, backgroundBusy: false, rejectRunner: false, auditMissing: false, tabReloads: 0, inferenceCalls: 0, generation: 3, stores };
  const model = { phase: 'ready', model: { id: 'selected' }, generation: fixture.generation,
    active: fixture.localActive, queued: 0, inferenceCalls: fixture.inferenceCalls };
  const settings = () => ({ ok: true, configVersion: 4, performancePaused: false,
    settings: { enabled: fixture.enabled, backend: 'local', concurrency: 2,
      localModelId: 'selected', videoBatchSize: 5, batchSize: 5, localPerformance: { warmup: false } } });
  globalThis.__fixtureBrowser = {
    runtime: { id: location.host, getManifest: () => ({ version: '0.4.14' }), getURL: path => location.origin + path,
      reload: () => { fixture.reloads++; },
      async sendMessage(message) {
        fixture.rpc.push(message);
        if (fixture.rejectRunner) return { ok: false, error: '不支持的消息来源' };
        if (message.type === 'settings') return settings();
        if (message.type === 'build-identity') return { ok: true, buildId: 'fixture-build', idle: !fixture.backgroundBusy };
        if (message.type === 'local-control' && message.control.action === 'state')
          return { ok: true, state: { ...model, active: fixture.localActive, inferenceCalls: fixture.inferenceCalls } };
        if (message.type === 'local-control' && message.control.action === 'list')
          return { ok: true, models: [{ id: 'selected', availability: 'ready' }] };
        return { ok: false, error: 'fixture-rejected' };
      } },
    storage: { local: storage('local'), session: storage('session') },
    permissions: { async contains() { return fixture.permission; },
      async request(options) { fixture.permissionRequests.push(options); fixture.permission = true; return true; } },
    tabs: {
      async get(id) { if (fixture.tab?.id === id) return { ...fixture.tab }; throw Error('No tab'); },
      async getCurrent() { return { id: 100, url: location.href }; },
      async create(options) { fixture.tab = { id: fixture.nextTabId++, url: undefined, pendingUrl: options.url };
        return { ...fixture.tab }; },
      async update(id, options) { if (fixture.tab?.id !== id) throw Error('No tab');
        fixture.tab = { ...fixture.tab, ...options }; return { ...fixture.tab }; },
      async reload(id) { if (fixture.tab?.id !== id) throw Error('No tab'); fixture.tabReloads++; },
      async remove(id) { fixture.removed.push(id); if (fixture.tab?.id === id) fixture.tab = null; },
      async sendMessage(id, message) {
        fixture.sentMessages.push({ id, type: message.type });
        if (fixture.tab?.id !== id || fixture.tab.url !== targetUrl) throw Error('No target');
        if (message.type === 'dispatch-runner-action') {
          if (fixture.auditMissing) return undefined;
          fixture.audit.push(message.action);
          if (message.action === 'status') return { ok: true, idle: true, paused: true, videoTimeMs: 52000 };
          if (message.action === 'prepare') { fixture.prepareCount++;
            return { ok: true, inspection: { identity: { resourceId: 'fixture-resource' } },
              localPreview: { ok: true, resourceId: 'fixture-resource', configVersion: 4,
                dispatch: { savedBatchLimit: 5 } } };
          }
          return { ok: true };
        }
        fixture.watch.push(message.type);
        if (message.type === 'bilibili-experiment-configure') return { ok: true, version: '0.4.14',
          buildId: 'fixture-build', effectiveBatchLimit: 1, concurrency: 2, singleDispatch: true };
        if (message.type === 'bilibili-experiment-stop') return { ok: true };
        if (message.type === 'bilibili-experiment-preview') return { ok: true, resourceId: 'fixture-resource',
          buildId: 'fixture-build', effectiveBatchLimit: 5, session: { generation: 5 } };
        throw Error('Unexpected watch message');
      },
    },
  };
}

try {
  await bundleFixture();
  server = createServer(async (req, res) => {
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.origin !== allowedOrigin)
      return reply(res, 403, { error: 'origin' });
    if (req.method === 'OPTIONS') return reply(res, 200, {});
    if (req.headers.authorization !== `Bearer ${token}`) return reply(res, 403, { error: 'auth' });
    if (req.method === 'POST' && req.url === '/command') {
      if (poll) return reply(res, 409, { error: 'parallel-poll' });
      poll = res; res.on('close', () => { if (poll === res) poll = null; }); deliver(); return;
    }
    if (req.method !== 'POST' || !['/hello', '/result'].includes(req.url)) return reply(res, 404, {});
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 64 * 1024 * 1024) throw Error('too-large'); }
      const data = JSON.parse(body);
      if (req.url === '/hello') hello = data;
      else { const job = pending.get(data.id); assert.ok(job, 'unknown result');
        pending.delete(data.id); clearTimeout(job.timer);
        data.ok ? job.resolve(data.result) : job.reject(Error(data.error));
      }
      reply(res, 200, { ok: true });
    } catch (error) { reply(res, 400, { error: error.message }); }
  });
  await new Promise(resolveServer => server.listen(0, '127.0.0.1', resolveServer));
  uiServer = createServer(async (req, res) => {
    const files = { '/dispatch-runner.html': ['dispatch-runner.html', 'text/html'],
      '/runner.js': ['runner.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
    const file = files[req.url];
    if (!file) { res.writeHead(404); res.end(); return; }
    try { res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' });
      res.end(await readFile(resolve(extension, file[0]))); }
    catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolveServer => uiServer.listen(0, '127.0.0.1', resolveServer));
  allowedOrigin = `http://127.0.0.1:${uiServer.address().port}`;
  const { chromium } = await loadPlaywright();
  context = await chromium.launchPersistentContext(resolve(run, 'profile'), { ...browserLaunchOptions('chrome'),
    headless: true, viewport: { width: 760, height: 560 }, args: ['--disable-background-networking', '--no-first-run'] });
  context.setDefaultTimeout(10000);
  await context.addInitScript(mockBrowserPage);
  page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(`${allowedOrigin}/dispatch-runner.html#port=${server.address().port}&token=${token}`);
  await page.locator('#connect:not([disabled])').waitFor();
  check('permission is requested by the visible Connect gesture', await page.locator('#connection-state').textContent() === '未连接');
  await page.locator('#connect').click();
  await until(() => hello, 'authenticated hello');
  check('permission scoped to loopback', (await page.evaluate(() => __fixture.permissionRequests))[0]?.origins?.[0] === 'http://127.0.0.1/*');
  check('fixture version reaches controller', hello.version === '0.4.14' && hello.extensionId === new URL(allowedOrigin).host);
  const box = await page.locator('main').boundingBox();
  check('compact visible page', box && box.width <= 760 && await page.locator('#disconnect').isVisible());
  await page.screenshot({ path: screenshot, fullPage: true }); report.screenshots.push(screenshot);
  assert.equal((await command('rpc', { type: 'settings' })).settings.enabled, false);
  check('settings RPC allowlisted', true);
  await assert.rejects(command('rpc', { type: 'configure', settings: { enabled: true } }), /INVALID_RPC/);
  check('arbitrary RPC rejected before browser API', !((await page.evaluate(() => __fixture.rpc)).some(x => x.type === 'configure')));
  const opened = await command('openTarget');
  check('new target begins pending with retained ownership', opened.tabId === 101 &&
    await page.evaluate(() => __fixture.tab.url === undefined &&
      __fixture.tab.pendingUrl === 'https://www.bilibili.com/video/BV1yvhW6sEzi/#danlingo-audit' &&
      __fixture.stores.local['dispatchRunner.owned.v1'] === 101));
  await assert.rejects(command('audit', { action: 'status', args: {} }), /TARGET_NAVIGATION_PENDING/);
  check('pending target receives no audit message', await page.evaluate(() =>
    __fixture.sentMessages.length === 0 && __fixture.stores.local['dispatchRunner.owned.v1'] === 101));
  await page.evaluate(() => sessionStorage.setItem('dispatchFixtureReload', JSON.stringify({
    stores: __fixture.stores, tab: __fixture.tab, nextTabId: __fixture.nextTabId,
  })));
  hello = null;
  await page.reload();
  await until(() => page.locator('#target-state').textContent().then(text => text?.includes('正在打开 · 101')),
    'pending ownership restored');
  check('control page reload restores pending target ID', await page.evaluate(() =>
    __fixture.stores.local['dispatchRunner.owned.v1'] === 101 && __fixture.tab.pendingUrl &&
    __fixture.tab.url === undefined));
  await page.locator('#connect').click(); await until(() => hello, 'reloaded authenticated hello');
  await assert.rejects(command('audit', { action: 'status', args: {} }), /TARGET_NAVIGATION_PENDING/);
  check('restored pending target still receives no audit', await page.evaluate(() =>
    __fixture.sentMessages.length === 0 && __fixture.stores.local['dispatchRunner.owned.v1'] === 101));
  await page.evaluate(() => { __fixture.tab.url = __fixture.tab.pendingUrl; delete __fixture.tab.pendingUrl; });
  const ready = await command('audit', { action: 'status', args: {} });
  check('audit starts after target navigation completes', ready.ok === true &&
    await page.evaluate(() => __fixture.sentMessages.length === 1 && __fixture.audit[0] === 'status'));
  await page.evaluate(() => { __fixture.auditMissing = true; });
  await assert.rejects(command('audit', { action: 'status', args: {} }), /AUDIT_NOT_READY/);
  await page.evaluate(() => { __fixture.auditMissing = false; });
  check('late audit listener recovers on the same owned target',
    (await command('audit', { action: 'status', args: {} })).ok === true &&
    await page.evaluate(() => __fixture.stores.local['dispatchRunner.owned.v1'] === 101));
  const prepare = await command('audit', { action: 'prepare', args: {} });
  check('prepare config applies and restores with zero model calls', prepare.configurationProbe.apply.effectiveBatchLimit === 1 &&
    prepare.configurationProbe.stop.ok === true && prepare.configurationProbe.restored.effectiveBatchLimit === 5 &&
    prepare.configurationProbe.inference.before === 0 && prepare.configurationProbe.inference.after === 0 &&
    (await page.evaluate(() => __fixture.prepareCount)) === 2);
  await command('openTarget', { refresh: true });
  check('refresh explicitly reloads the owned document even at the same URL',
    await page.evaluate(() => __fixture.tabReloads === 1 && __fixture.tab.id === 101 && __fixture.tab.active));
  await page.evaluate(() => { __fixture.localActive = 1; });
  await assert.rejects(command('reload'), /LOCAL_MODEL_BUSY/);
  check('reload rejects busy local model', (await page.evaluate(() => __fixture.reloads)) === 0);
  await page.evaluate(() => { __fixture.localActive = 0; });
  await page.evaluate(() => { __fixture.backgroundBusy = true; });
  await assert.rejects(command('reload'), /BACKGROUND_NOT_IDLE/);
  check('reload rejects other background activity with idle local model', (await page.evaluate(() => __fixture.reloads)) === 0);
  await page.evaluate(() => { __fixture.backgroundBusy = false; });
  await page.evaluate(() => { __fixture.rejectRunner = true; });
  await assert.rejects(command('reload', { bootstrap: true }), /不支持的消息来源/);
  check('old background refusal cannot bootstrap an unchecked reload', (await page.evaluate(() => __fixture.reloads)) === 0);
  await page.evaluate(() => { __fixture.rejectRunner = false; });
  const reload = await command('reload');
  await until(() => page.evaluate(() => __fixture.reloads), 'mock reload');
  check('reload waits for complete idle proof', reload.willReload === true);
  report.firstPage = await page.evaluate(() => ({ removed: __fixture.removed, watch: __fixture.watch,
    audit: __fixture.audit, inferenceCalls: __fixture.inferenceCalls }));
  await page.close();
  hello = null; page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(`${allowedOrigin}/dispatch-runner.html#port=${server.address().port}&token=${token}`);
  await page.locator('#connect').click(); await until(() => hello, 'second authenticated hello');
  await command('openTarget');
  await page.evaluate(() => { __fixture.tab.url = __fixture.tab.pendingUrl; delete __fixture.tab.pendingUrl; });
  await page.evaluate(() => { __fixture.tab.pendingUrl = 'https://example.com/'; });
  await assert.rejects(command('audit', { action: 'status', args: {} }), /OWNED_TARGET_UNAVAILABLE/);
  check('foreign pending navigation loses ownership without audit', await page.evaluate(() =>
    __fixture.stores.local['dispatchRunner.owned.v1'] === undefined && __fixture.sentMessages.length === 0 &&
    __fixture.tab.url === 'https://www.bilibili.com/video/BV1yvhW6sEzi/#danlingo-audit'));
  const replacement = await command('openTarget');
  await page.evaluate(() => { __fixture.tab.url = __fixture.tab.pendingUrl; delete __fixture.tab.pendingUrl; });
  await command('close-owned');
  check('cleanup closes only the new owned target', replacement.tabId === 102 &&
    JSON.stringify(await page.evaluate(() => __fixture.removed)) === '[102]');
  queue.push({ idle: true, closing: true }); deliver();
  await until(() => page.evaluate(() => __fixture.removed.includes(100)), 'controller self-close');
  check('normal shutdown leaves foreign tab alone', JSON.stringify(await page.evaluate(() => __fixture.removed)) === '[102,100]');
  check('fixture page has no uncaught exceptions', report.errors.length === 0);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.errors.push(error.stack ?? String(error)); process.exitCode = 1;
  console.error(error);
} finally {
  for (const job of pending.values()) { clearTimeout(job.timer); job.reject(Error('fixture stopped')); }
  await context?.close().catch(() => {});
  server?.closeAllConnections();
  if (server) await new Promise(resolveServer => server.close(resolveServer));
  uiServer?.closeAllConnections();
  if (uiServer) await new Promise(resolveServer => uiServer.close(resolveServer));
  report.completedAt = new Date().toISOString();
  await writeFile(resolve(run, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, run, checks: report.checks.length, errors: report.errors.length }));
}
