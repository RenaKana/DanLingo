// Production extension acceptance with a loopback-only provider and a real 90s
// wait BEFORE response headers. No provider keys, personal profile, Playwright,
// or service-worker debugger attachment. Run only after the extension is built.
import assert from 'node:assert/strict';
import { browserExecutablePath } from './browser-runtime.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, cp, readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

const delay = ms => new Promise(done => setTimeout(done, ms));
const browser = browserExecutablePath('chromium');
const artifacts = resolve('.artifacts/long-thinking');
await mkdir(artifacts, { recursive: true });
const runDir = await mkdtemp(resolve(artifacts, 'run-'));
const extension = resolve(runDir, 'test-extension');
const profile = resolve(runDir, 'profile');
const startedAt = Date.now();
const report = {
  capturedAt: new Date(startedAt).toISOString(), runDir, browser, profile,
  evidence: 'Production MV3 extension, synthetic native fixture, local mock, real wall-clock 90000ms before headers',
  limitations: [
    'Synthetic Niconico player checks production content/native bridge contracts, not real-site player internals or a real provider.',
    'Only the test manifest pregrants loopback permission. Native permission consent is not covered.',
    'Content status RPCs are intercepted in the existing isolated world and recorded locally; translate/cancel/configuration calls retain the production flow.',
  ],
  checks: {}, requests: [], attachments: [], errors: [], runtimeErrors: [], cleanup: {},
};
const key = 'danlingo-long-thinking-local-test-only';
let phase = 'setup', proc, ws, command, rpc, options, page, debugOrigin, extensionId;
let mock, interrupted = false;
const timers = new Set();
const pending = new Map();
const contexts = new Map();
const sessions = new Map();
const held = new Set();
const saveReport = () => writeFile(resolve(runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
async function until(check, label, timeout = 15000, interval = 100) {
  const end = Date.now() + timeout;
  while (!interrupted && Date.now() < end) {
    const result = await check();
    if (result) return result;
    await delay(interval);
  }
  throw new Error(`${interrupted ? 'Run interrupted' : 'Timed out'}: ${label}`);
}

// Minimal paused player: two ordinary Japanese comments enter one near batch.
// Keep native timing and source identities intact; no product bundle is patched.
function installFixture() {
  const observed = window.__DL_LONG__ = { prepared: [], ui: [], staged: [], messages: [] };
  window.addEventListener('message', event => {
    const d = event.data;
    if (event.source !== window || d?.bridge !== 'danlingo.native.v1') return;
    if (d.from === 'content' && d.type === 'prepared') {
      observed.prepared.push(...d.items.map(item => ({ ...item, at: Date.now() })));
    }
    if (d.from === 'native' && d.type === 'sources') observed.sourceCount = d.upserts.length;
  });
  const install = () => {
    const stage = document.getElementById('stage');
    const video = stage.querySelector('video');
    const state = { paused: true, time: 0, playCalls: 0, pauseCalls: 0, refreshCalls: 0 };
    const suffix = location.pathname.split('/').at(-1);
    const rows = [0, 1].map(n => ({ id: `comment-${n}`, thread: 'long-thinking', fork: 'main', vposMs: n * 1000,
      position: 'naka', size: 'medium', color: '#ffffff', font: 'defont',
      comment: { body: `長い思考を待っているコメント${n} ${suffix}`, commands: ['184', 'naka', 'white'], postedAt: '2026-09-01T00:00:00Z' } }));
    Object.defineProperties(video, {
      paused: { get: () => state.paused }, seeking: { get: () => false }, currentTime: { get: () => state.time },
      duration: { get: () => 120 }, readyState: { get: () => 4 }, playbackRate: { get: () => 1 },
      buffered: { get: () => ({ length: 0 }) }, played: { get: () => ({ length: 0 }) },
    });
    video.play = async () => { state.playCalls++; state.paused = false; };
    video.pause = () => { state.pauseCalls++; state.paused = true; };
    const filters = new Map();
    const render = row => {
      let settings = { visible: true, content: row.comment.body };
      for (const filter of filters.values()) settings = filter(row, settings);
      const result = { id: row.id, original: row.comment.body, text: settings.content, at: Date.now() };
      observed.staged.push(result);
      document.getElementById(row.id).textContent = result.text;
      return result;
    };
    const player = {
      watch: { video: { id: suffix, duration: 120 } }, context: {}, isDisposed: false, _isInterrupting: false, stage,
      getCurrentTime: () => state.time, getPlaybackRate: () => 1, getVideoElement: () => video,
      isPlaying: () => !state.paused, isSeeking: () => false, isReady: () => true, isDummyVideo: () => false,
      commentRenderer: { parentElement: stage, layerProcessorList: [{
        stagingChatManager: { chatList: rows }, processor: { contentLengthMs: 120000 },
        addStagingFilter: (name, fn) => filters.set(name, fn), removeStagingFilter: name => filters.delete(name),
        getStagingFilterNameList: () => [...filters.keys()],
      }], refreshComments: () => { state.refreshCalls++; rows.forEach(render); } },
    };
    video.__reactFiber$danlingoLong = { memoizedProps: { player }, return: null };
    window.__DL_LONG_FIXTURE__ = { player, state, rows, renderAll: () => rows.map(render) };
    rows.forEach(render);
    setInterval(() => {
      const host = document.getElementById('danlingo-progress');
      const root = host?.shadowRoot;
      if (root) observed.ui.push({ at: Date.now(), visible: !host.hidden,
        summary: root.getElementById('progress-summary')?.textContent,
        title: root.querySelector('summary')?.title, note: root.getElementById('note')?.textContent });
    }, 500);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
}

// Intercept only the production status heartbeat, in its existing content world.
// This observes scheduler state without an extension API call waking the worker.
function suppressStatusHeartbeats(expectedId) {
  const api = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
  if (api?.runtime?.id !== expectedId) return false;
  const state = globalThis.__DL_LONG_WIRE__ = { statuses: [], other: [], installedAt: Date.now() };
  const original = api.runtime.sendMessage;
  api.runtime.sendMessage = function (...args) {
    const payload = args[0];
    if (payload?.type === 'status') {
      state.statuses.push({ at: Date.now(), ...payload.status });
      const result = { ok: true, engineNotice: '' };
      if (typeof args.at(-1) === 'function') { args.at(-1)(result); return; }
      return Promise.resolve(result);
    }
    state.other.push({ at: Date.now(), type: payload?.type ?? 'unknown' });
    return original.apply(this, args);
  };
  return true;
}

const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>DanLingo long thinking acceptance</title>
<style>body{margin:0;background:#111a20;color:#f6f9fb;font:16px system-ui}main{max-width:1100px;margin:28px auto}h1{font-size:21px;font-weight:500}p{color:#b6c7d2}#stage{position:relative;isolation:isolate;height:570px;background:linear-gradient(130deg,#17374b,#18302b);overflow:hidden}video{width:100%;height:100%;object-fit:cover}.comment{position:absolute;left:10%;font-size:24px;text-shadow:1px 2px 3px #000}#comment-0{top:38%}#comment-1{top:55%}</style>
<main><h1>DanLingo · 90 second thinking response</h1><p>Synthetic paused native player · local mock · first response headers after 90 seconds</p><div id="stage"><video></video><div class="comment" id="comment-0"></div><div class="comment" id="comment-1"></div></div></main></html>`;

async function evaluate(surface, expression, contextId) {
  const result = await command('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, userGesture: true, ...(contextId ? { contextId } : {}),
  }, surface.sessionId);
  if (result.exceptionDetails) throw new Error('Page evaluation failed: ' + JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function attach(targetId) {
  const { targetInfos } = await command('Target.getTargets');
  const info = targetInfos.find(item => item.targetId === targetId);
  assert.equal(info?.type, 'page', 'Never attach a service-worker or other background target');
  const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
  report.attachments.push({ at: Date.now(), type: info.type, targetId, sessionId, url: info.url });
  const surface = { targetId, sessionId };
  sessions.set(sessionId, surface); contexts.set(sessionId, new Map());
  await command('Page.enable', {}, sessionId);
  await command('Runtime.enable', {}, sessionId);
  return surface;
}
async function detach(surface) {
  await command('Target.detachFromTarget', { sessionId: surface.sessionId });
  report.attachments.push({ at: Date.now(), detached: true, targetId: surface.targetId });
  sessions.delete(surface.sessionId);
}
async function newPage(url = 'about:blank') {
  const { targetId } = await command('Target.createTarget', { url });
  return attach(targetId);
}
async function screenshot(surface, name) {
  const { data } = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, surface.sessionId);
  const path = resolve(runDir, `${name}.png`);
  await writeFile(path, Buffer.from(data, 'base64'));
  return path;
}
async function findContentWorld(surface) {
  return until(async () => {
    for (const context of contexts.get(surface.sessionId)?.values() ?? []) {
      if (context.auxData?.isDefault) continue;
      const match = await evaluate(surface, `globalThis.chrome?.runtime?.id === ${JSON.stringify(extensionId)}`, context.id).catch(() => false);
      if (match) return context.id;
    }
    return null;
  }, 'production content-script execution world');
}
async function fixture(videoId) {
  const surface = await newPage();
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, surface.sessionId);
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `(${installFixture.toString()})();` }, surface.sessionId);
  await command('Fetch.enable', { patterns: [{ urlPattern: 'https://www.nicovideo.jp/*' }] }, surface.sessionId);
  await command('Page.navigate', { url: `https://www.nicovideo.jp/watch/${videoId}` }, surface.sessionId);
  await until(() => evaluate(surface, '!!window.__DL_LONG_FIXTURE__'), 'native fixture');
  surface.contentWorld = await findContentWorld(surface);
  assert.equal(await evaluate(surface, `(${suppressStatusHeartbeats.toString()})(${JSON.stringify(extensionId)})`, surface.contentWorld), true);
  await until(() => evaluate(surface, '!!document.getElementById("danlingo-progress")'), 'production progress host');
  return surface;
}
async function snapshot(surface) {
  return {
    page: await evaluate(surface, '({ ...window.__DL_LONG__, fixture: window.__DL_LONG_FIXTURE__.state, rows: window.__DL_LONG_FIXTURE__.rows, filters: window.__DL_LONG_FIXTURE__.player.commentRenderer.layerProcessorList[0].getStagingFilterNameList() })'),
    wire: await evaluate(surface, 'globalThis.__DL_LONG_WIRE__', surface.contentWorld),
  };
}
async function save(patch) {
  const settings = (await rpc({ type: 'settings' })).settings;
  const response = await rpc({ type: 'save', settings: { ...settings, ...patch }, remember: false });
  assert.equal(response.ok, true, response.error);
  return response.settings;
}

try {
  await access(browser);
  await cp(resolve('.output/chrome-mv3'), extension, { recursive: true });
  const manifestPath = resolve(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), 'http://127.0.0.1/*'])];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  report.manifestChange = { addedHostPermission: 'http://127.0.0.1/*', bundleChanges: false };
  mock = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type' }); res.end(); return; }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; assert.ok(body.length < 100000, 'Small fixture request size'); }
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      const json = JSON.parse(body);
      assert.equal(json.model, 'deepseek-flash');
      assert.deepEqual(json.thinking, { type: 'enabled' });
      assert.equal(json.reasoning_effort, 'high');
      const inputs = JSON.parse(json.messages.find(message => message.role === 'user').content).items;
      assert.equal(inputs.length, 2, 'Two eligible source comments in one provider POST');
      const row = { phase, receivedAt: Date.now(), model: json.model, thinking: json.thinking, reasoning_effort: json.reasoning_effort,
        items: inputs.length, ids: inputs.map(item => item.id), delayBeforeHeadersMs: phase === 'long-success' ? 90000 : null };
      report.requests.push(row);
      assert.ok(report.requests.length <= 6, 'Bounded request budget');
      res.on('close', () => {
        row.closedAt = Date.now();
        if (!res.writableFinished) row.abortedAt = Date.now();
      });
      const respond = () => {
        held.delete(respond);
        if (res.destroyed) { row.responseSkippedAfterAbort = true; return; }
        row.headersSentAt = Date.now();
        row.elapsedBeforeHeadersMs = row.headersSentAt - row.receivedAt;
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', reasoning_content: 'Local test thinking completed.',
          content: JSON.stringify({ items: inputs.map(item => ({ id: item.id, text: '【长思考译文】' + item.text })) }) } }] }));
      };
      if (phase === 'long-success') {
        const timer = setTimeout(() => { timers.delete(timer); respond(); }, 90000); timers.add(timer);
      } else held.add(respond);
    } catch (error) {
      report.errors.push('mock: ' + String(error));
      if (!res.destroyed) { res.writeHead(500); res.end('{}'); }
    }
  });
  await new Promise(done => mock.listen(0, '127.0.0.1', done));
  const endpoint = `http://127.0.0.1:${mock.address().port}/v1/chat/completions`;
  report.endpoint = endpoint;
  proc = spawn(browser, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-gpu',
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const browserAddress = await new Promise((done, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => reject(new Error('Browser startup timed out')), 15000);
    proc.once('error', error => { clearTimeout(timeout); reject(error); });
    proc.once('exit', code => { clearTimeout(timeout); reject(new Error(`Browser exited ${code}: ${stderr.slice(-700)}`)); });
    proc.stderr.on('data', chunk => {
      stderr += String(chunk);
      const address = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
      if (address) { clearTimeout(timeout); done(address); }
    });
  });
  debugOrigin = browserAddress.replace(/^ws:/, 'http:').split('/devtools/')[0];
  ws = new WebSocket(browserAddress);
  await new Promise((done, reject) => { ws.addEventListener('open', done, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let nextId = 0;
  command = (method, params = {}, sessionId) => new Promise((done, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 10000);
    pending.set(id, { done, reject, timeout });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const call = pending.get(message.id);
      if (call) { pending.delete(message.id); clearTimeout(call.timeout); message.error ? call.reject(new Error(JSON.stringify(message.error))) : call.done(message.result); }
    }
    if (message.method === 'Runtime.executionContextCreated') contexts.get(message.sessionId)?.set(message.params.context.id, message.params.context);
    if (message.method === 'Runtime.executionContextsCleared') contexts.get(message.sessionId)?.clear();
    if (message.method === 'Runtime.executionContextDestroyed') contexts.get(message.sessionId)?.delete(message.params.executionContextId);
    if (message.method === 'Runtime.exceptionThrown') report.runtimeErrors.push({ at: Date.now(), sessionId: message.sessionId, details: message.params.exceptionDetails });
    if (message.method === 'Fetch.requestPaused') {
      const p = message.params;
      void command('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: p.resourceType === 'Document' ? 200 : 404,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
        body: Buffer.from(p.resourceType === 'Document' ? html : '').toString('base64') }, message.sessionId).catch(error => report.errors.push('fixture interception: ' + String(error)));
    }
  });
  const budget = setTimeout(() => { interrupted = true; report.errors.push('Five-minute run budget exceeded'); proc?.kill(); }, 300000);
  timers.add(budget);
  report.browserVersion = await command('Browser.getVersion');
  // Read-only HTTP discovery never attaches or runs code in the worker.
  const candidates = await until(async () => {
    const targets = await fetch(`${debugOrigin}/json/list`).then(response => response.json());
    report.discoveryTargets = targets.map(({ type, url, title }) => ({ type, url, title }));
    const workers = targets.filter(target => target.type === 'service_worker' && target.url.startsWith('chrome-extension://') && target.url.endsWith('/' + manifest.background.service_worker));
    return workers.length ? workers.map(worker => new URL(worker.url).host) : null;
  }, 'extension service worker discovery');
  report.discoveryProbes = [];
  for (const candidate of candidates) {
    const probe = await newPage(`chrome-extension://${candidate}/options.html`);
    await until(() => evaluate(probe, 'document.readyState === "complete"'), 'candidate options document', 5000);
    const identified = await evaluate(probe, '({ url: location.href, name: globalThis.chrome?.runtime?.getManifest?.().name })');
    report.discoveryProbes.push({ candidate, ...identified });
    if (identified.name === manifest.name) { extensionId = candidate; options = probe; break; }
    await command('Target.closeTarget', { targetId: probe.targetId });
  }
  assert.ok(options && extensionId, 'Identify DanLingo by its options-page manifest, without inspecting worker execution');
  report.extensionId = extensionId;
  rpc = payload => evaluate(options, `chrome.runtime.sendMessage(${JSON.stringify(payload)})`);
  await until(() => evaluate(options, '!!document.getElementById("key-state")?.textContent'), 'options loaded');
  const defaults = (await rpc({ type: 'settings' })).settings;
  assert.equal(defaults.requestTimeoutMs, 12000);
  assert.equal(defaults.thinkingRequestTimeoutMs, 120000);
  const configured = await rpc({ type: 'save', settings: { ...defaults, endpoint, allowLocalHttp: true, enabled: false,
    model: 'deepseek-flash', profile: 'deepseek', thinkingEffort: 'high', sourceLanguage: 'ja', targetLanguage: 'zh-Hans',
    translationScope: 'all', concurrency: 1, batchSize: 100 }, apiKey: key, remember: false });
  assert.equal(configured.ok, true, configured.error);
  assert.equal(configured.hasKey, true);
  await command('Page.reload', {}, options.sessionId);
  const timeoutField = await until(() => evaluate(options, `(() => {
    const inputs = [...document.querySelectorAll('input[type=number]')];
    return inputs.find(input => /thinking.*timeout|timeout.*thinking/.test(input.id))?.id;
  })()`), 'thinking timeout setting control');
  await until(() => evaluate(options, `document.getElementById(${JSON.stringify(timeoutField)}).value === '120000'`), 'visible 120s thinking default');
  for (const value of [110000, 120000]) {
    await evaluate(options, `(() => { const input = document.getElementById(${JSON.stringify(timeoutField)});
      const details = input.closest('details'); if (details) details.open = true;
      input.value = '${value}'; input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('save').click(); })()`);
    await until(async () => (await rpc({ type: 'settings' })).settings.thinkingRequestTimeoutMs === value, `UI saves thinking timeout ${value}`);
    await until(() => evaluate(options, 'document.getElementById("result").textContent === "已保存"'), 'UI save completion');
  }
  report.checks.settings = { defaults: { requestTimeoutMs: 12000, thinkingRequestTimeoutMs: 120000 }, fieldId: timeoutField,
    savedThroughForm: [110000, 120000], screenshot: await screenshot(options, 'options-thinking-120s') };
  for (const value of [16, 1]) {
    await evaluate(options, `(() => { const input = document.getElementById('concurrency');
      input.value = '${value}'; input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('save').click(); })()`);
    await until(async () => (await rpc({ type: 'settings' })).settings.concurrency === value, `UI saves concurrency ${value}`);
    await until(() => evaluate(options, 'document.getElementById("result").textContent === "已保存"'), 'concurrency UI save completion');
  }
  report.checks.settings.concurrencySavedThroughForm = [16, 1];
  await rpc({ type: 'clear-cache' });

  phase = 'long-success';
  page = await fixture('sm999999981');
  await rpc({ type: 'toggle', enabled: true });
  const longRequest = await until(() => report.requests.find(row => row.phase === phase), 'real 90s provider request starts');
  await until(() => evaluate(page, 'globalThis.__DL_LONG_WIRE__.statuses.some(status => status.inflight === 1 && status.queued === 2 && status.failed === 0)', page.contentWorld), 'waiting scheduler status');
  report.checks.waitingScreenshot = await screenshot(page, 'waiting-before-headers');
  const targetIds = { options: options.targetId, page: page.targetId };
  await detach(page); await detach(options);
  const detachedAt = Date.now();
  report.checks.quietWait = { detachedAt, noWorkerDebugger: true, noPageDebuggerWhileWaiting: true, noStatusRpcWhileWaiting: true };
  console.log('90s pre-header response pending; all page CDP sessions detached, content status RPCs locally suppressed.');
  // Wait only on local server state. No CDP command, extension RPC or target poll.
  await until(() => longRequest.headersSentAt || longRequest.abortedAt, '90s response headers or truthful early cancellation', 95000, 250);
  if (longRequest.abortedAt && !longRequest.headersSentAt) throw new Error(`Provider socket aborted after ${longRequest.abortedAt - longRequest.receivedAt}ms before the 90s response`);
  await delay(1500);
  report.checks.quietWait.reattachedAt = Date.now();
  options = await attach(targetIds.options);
  page = await attach(targetIds.page); page.contentWorld = await findContentWorld(page);
  await until(() => evaluate(page, 'window.__DL_LONG__.prepared.length === 2'), 'prepared translations after delayed response');
  await until(() => evaluate(page, 'window.__DL_LONG__.staged.filter(row => row.text.startsWith("【长思考译文】")).length >= 2'), 'production native paused refresh staging');
  const success = await snapshot(page);
  report.checks.longSuccess = { ...success, overview: await rpc({ type: 'overview' }), screenshot: await screenshot(page, 'prepared-after-90s') };
  const during = success.wire.statuses.filter(status => status.at >= detachedAt && status.at < longRequest.headersSentAt);
  assert.ok(during.length >= 100, 'Collect status continuously throughout real wall-clock wait');
  assert.ok(during.every(status => status.inflight === 1 && status.queued === 2 && status.failed === 0 && status.prepared === 0 && status.state === 'translating'), 'Waiting remains active and never fails before response');
  assert.equal(success.wire.other.filter(event => event.at >= detachedAt && event.at < longRequest.headersSentAt).length, 0, 'No other content-to-background API traffic during quiet wait');
  assert.ok(success.page.ui.filter(row => row.at >= detachedAt && row.at < longRequest.headersSentAt).every(row => row.visible && /0 条失败/.test(row.title)), 'Visible waiting UI never reports failure');
  assert.ok(success.page.prepared.every(row => row.at >= longRequest.headersSentAt && row.text.startsWith('【长思考译文】')));
  assert.ok(longRequest.elapsedBeforeHeadersMs >= 90000 && longRequest.elapsedBeforeHeadersMs < 93000);
  assert.equal(report.requests.filter(row => row.phase === 'long-success').length, 1, 'Long success must use exactly one POST');
  assert.equal(report.checks.longSuccess.overview.engine.retries, 0, 'Long success must not retry');
  assert.equal(success.page.fixture.playCalls, 0); assert.equal(success.page.fixture.pauseCalls, 0);
  report.checks.longSuccess.statusSamplesBeforeHeaders = during.length;
  report.checks.longSuccess.passed = true;
  await saveReport();
  console.log(`PASS: ${longRequest.elapsedBeforeHeadersMs}ms before headers, single POST, two native staged translations, no early failure.`);

  await rpc({ type: 'toggle', enabled: false });
  await command('Target.closeTarget', { targetId: page.targetId }); page = null;
  phase = 'cancel';
  page = await fixture('sm999999982');
  await rpc({ type: 'toggle', enabled: true });
  const cancelRequest = await until(() => report.requests.find(row => row.phase === phase), 'held request for cancellation');
  await until(() => evaluate(page, 'globalThis.__DL_LONG_WIRE__.statuses.some(status => status.inflight === 1)', page.contentWorld), 'cancellation request inflight');
  const disabledAt = Date.now();
  assert.equal((await rpc({ type: 'toggle', enabled: false })).ok, true);
  await until(() => cancelRequest.abortedAt, 'disable aborts provider socket', 5000);
  for (const release of [...held]) release();
  await delay(2500);
  const cancelled = await snapshot(page);
  assert.equal(cancelled.page.prepared.length, 0, 'Disable prevents late prepared output');
  assert.equal(report.requests.filter(row => row.phase === phase).length, 1, 'Cancel has no retry');
  assert.ok(cancelRequest.abortedAt - disabledAt < 5000);
  assert.equal((await rpc({ type: 'overview' })).engine.activeRequests, 0);
  report.checks.cancel = { passed: true, disabledAt, abortedAt: cancelRequest.abortedAt, latePrepared: 0, snapshot: cancelled };
  await command('Target.closeTarget', { targetId: page.targetId }); page = null;

  phase = 'timeout';
  await save({ enabled: false, thinkingRequestTimeoutMs: 1000 });
  page = await fixture('sm999999983');
  await rpc({ type: 'toggle', enabled: true });
  await until(() => evaluate(page, 'globalThis.__DL_LONG_WIRE__.statuses.some(status => status.failed === 2 && status.inflight === 0)', page.contentWorld), 'explicit short thinking timeout settles as failed', 15000);
  const timedOut = await snapshot(page);
  const timeoutRequests = report.requests.filter(row => row.phase === 'timeout');
  await until(() => timeoutRequests.every(row => row.abortedAt), 'timeout attempts abort sockets', 3000);
  assert.equal(timeoutRequests.length, 2, 'Initial timed-out attempt plus one bounded retry');
  assert.ok(timeoutRequests.every(row => row.abortedAt - row.receivedAt >= 850 && row.abortedAt - row.receivedAt < 2500), 'Configured 1000ms deadline controls both attempts');
  assert.equal(timedOut.page.prepared.length, 0, 'Timed-out results never prepare');
  report.checks.timeout = { passed: true, thinkingRequestTimeoutMs: 1000, attempts: timeoutRequests.length, snapshot: timedOut,
    screenshot: await screenshot(page, 'configured-short-timeout') };
  for (const release of [...held]) release();

  await rpc({ type: 'toggle', enabled: false });
  const deleted = await rpc({ type: 'delete-key' });
  assert.equal(deleted.ok, true); assert.equal(deleted.hasKey, false);
  report.cleanup.keyDeleted = true;
  const idleStartedAt = Date.now();
  for (const targetId of [page.targetId, options.targetId]) await command('Target.closeTarget', { targetId });
  page = null; options = null; rpc = null;
  // A finite per-request heartbeat should not keep the worker alive after work.
  // Closing all extension/content pages removes their own lifecycle traffic.
  const idle = await until(async () => {
    const targets = await fetch(`${debugOrigin}/json/list`).then(response => response.json());
    return !targets.some(target => target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${extensionId}/`));
  }, 'background worker becomes idle after completed/cancelled/timed-out requests', 45000, 1000);
  assert.equal(idle, true);
  report.checks.idle = { passed: true, idleStartedAt, workerStoppedAt: Date.now(), method: 'read-only /json/list; no service worker debugger session' };
  assert.equal(report.errors.length, 0, report.errors.join('\n'));
  report.result = 'PASS';
} catch (error) {
  report.result = 'FAIL'; report.errors.push(String(error.stack ?? error)); process.exitCode = 1;
  // A failure during the quiet period must still allow evidence and key cleanup.
  if (options && !sessions.has(options.sessionId)) options = await attach(options.targetId).catch(() => options);
  if (page && !sessions.has(page.sessionId)) {
    page = await attach(page.targetId).catch(() => page);
    page.contentWorld = await findContentWorld(page).catch(() => null);
  }
  if (page) {
    report.failureScreenshot = await screenshot(page, 'failure').catch(() => null);
    report.failureState = await snapshot(page).catch(error => ({ unavailable: String(error) }));
  }
  if (options) {
    report.failureOptionsScreenshot = await screenshot(options, 'failure-options').catch(() => null);
    report.failureOptions = await evaluate(options, '({ url: location.href, ready: document.readyState, text: document.body?.innerText })').catch(error => ({ unavailable: String(error) }));
  }
} finally {
  if (rpc) {
    await rpc({ type: 'toggle', enabled: false }).catch(() => {});
    const deleted = await rpc({ type: 'delete-key' }).catch(() => null);
    report.cleanup.keyDeleted = deleted?.hasKey === false;
  }
  for (const timer of timers) clearTimeout(timer);
  for (const release of [...held]) release();
  if (command && ws?.readyState === WebSocket.OPEN) await command('Browser.close').catch(() => {});
  ws?.close();
  if (proc && proc.exitCode === null) proc.kill();
  for (const operation of pending.values()) { clearTimeout(operation.timeout); operation.reject(new Error('Run completed')); }
  pending.clear();
  if (mock) { mock.closeAllConnections(); await new Promise(done => mock.close(done)); }
  report.totalElapsedMs = Date.now() - startedAt;
  report.checks.noServiceWorkerDebuggerAttachment = report.attachments.every(row => row.detached || row.type === 'page');
  await saveReport();
}
console.log(JSON.stringify({ result: report.result, report: resolve(runDir, 'report.json'), totalElapsedMs: report.totalElapsedMs,
  requests: report.requests.map(({ phase, elapsedBeforeHeadersMs, receivedAt, abortedAt }) => ({ phase, elapsedBeforeHeadersMs, abortedAfterMs: abortedAt ? abortedAt - receivedAt : undefined })),
  errors: report.errors }, null, 2));
