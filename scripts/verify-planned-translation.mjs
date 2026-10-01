// Isolated Edge/built-extension planned translation against a loopback provider.
// Only synthetic native rows, a synthetic key and disposable profile are used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadPlaywright, browserLaunchOptions } from './browser-runtime.mjs';
import { FIRST_URL, videoHtml } from '../test/fixtures/bilibili-video-native.mjs';
import { USER_FILTER_NATIVE_CALLBACK, USER_FILTER_NATIVE_FUNCTIONS } from '../src/platforms/bilibili/user-filter-contract.ts';
import { LOCAL_CHANNEL } from '../src/local/types.ts';

const scenarioNames = ['default', 'wall-offset-5000', 'wall-offset--5000', 'hybrid-stale-capacity'];
const usage = 'Usage: node --experimental-strip-types scripts/verify-planned-translation.mjs <built-extension> [--scenario hybrid-stale-capacity]';
if (!process.argv[2]) throw new Error(usage);
const args = process.argv.slice(3);
if (args.length && (args.length !== 2 || args[0] !== '--scenario' || !scenarioNames.includes(args[1]))) throw new Error(usage);
const selectedScenario = args[1];
const sourceExtension = resolve(process.argv[2]);
await mkdir('.artifacts', { recursive: true });
const directory = await mkdtemp(resolve('.artifacts/planned-translation-'));
const extension = resolve(directory, 'extension');
await cp(sourceExtension, extension, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), 'http://127.0.0.1/*'])];
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
// The trusted document is our own disposable harness. No personal settings page
// or product options UI is opened; the copied background still authorizes RPCs.
await writeFile(resolve(extension, 'options.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>DanLingo isolated settings fixture</title><body><h1>DanLingo isolated settings fixture</h1><p>Synthetic settings RPC harness; no personal browser data.</p></body></html>');
let identity;
try { identity = JSON.parse(await readFile(resolve(extension, 'runtime-identity.json'), 'utf8')); } catch { identity = { version: manifest.version }; }
const report = { evidence: 'ISOLATED_EDGE_BUILT_EXTENSION_SYNTHETIC_NATIVE_LOOPBACK_PROVIDER',
  sourceExtension, identity, directory, scenarios: [], passed: false, OSClockChanged: false,
  credentials: 'SYNTHETIC_KEY_NOT_RECORDED', sourcePackageModified: false,
  settingsUiEvidence: 'SELF_CREATED_DISPOSABLE_RPC_HARNESS_NOT_PRODUCT_OPTIONS_UI' };
const fixtureModels = ['fixture-local-before-switch', 'fixture-local-after-switch'];
const capacityError = '请为当前本地模型和参数设置混合容量';
async function installUnloadedLocalFixture() {
  // Only the disposable extension copy is changed. Registered model metadata is
  // synthetic; ensure/load fail immediately and complete cannot run inference.
  await writeFile(resolve(extension, 'offscreen.html'), '<!doctype html><html><meta charset="utf-8"><title>Unloaded local-model fixture</title><script src="planned-local-fixture.js"></script></html>');
  await writeFile(resolve(extension, 'planned-local-fixture.js'), `
const models = ${JSON.stringify(fixtureModels)}.map(id => ({ id, name: id + '.gguf', files: [], bytes: 0,
  architecture: 'synthetic', quantization: 'synthetic', tokenizer: 'synthetic', template: false,
  importedAt: 1, availability: 'ready' }));
const trace = { evidence: 'MOCK_REGISTERED_MODELS_UNLOADED_NO_MODEL_WEIGHTS', actions: [], completeAttempts: 0, inferenceCalls: 0 };
let state = { phase: 'idle', backend: 'synthetic-unloaded', generation: 0,
  queued: 0, active: 0, completed: 0, failed: 0, cancelled: 0, peakActive: 0, inferenceCalls: 0 };
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.channel !== ${JSON.stringify(LOCAL_CHANNEL)} || sender.id !== chrome.runtime.id) return;
  trace.actions.push({ action: message.action, ...(message.modelId ? { modelId: message.modelId } : {}) });
  let result;
  if (message.action === 'list') result = { ok: true, models, directories: [], state };
  else if (message.action === 'state') result = { ok: true, state };
  else if (['ensure', 'load'].includes(message.action)) {
    state = { ...state, phase: 'error', error: 'LOCAL_LOAD_FAILED',
      model: models.find(model => model.id === message.modelId), requested: message.config };
    result = { ok: false, error: 'LOCAL_LOAD_FAILED', state };
  } else if (message.action === 'complete') {
    trace.completeAttempts++; result = { ok: false, error: 'LOCAL_MODEL_NOT_READY', state };
  } else if (['cancel', 'unload', 'abort'].includes(message.action)) result = { ok: true, state };
  else result = { ok: false, error: 'LOCAL_MODEL_NOT_READY', state };
  // Offscreen documents only expose chrome.runtime. Return trace through the
  // same mock reply instead of using unavailable storage APIs here.
  reply({ ...result, fixtureTrace: structuredClone(trace) });
});
`);
}
const rows = [
  { sourceId: '987654321', text: '译文显示测试', translated: '字幕が表示されます', stime: 3.5 },
  { sourceId: '987654322', text: '窗口内翻译测试', translated: 'ウィンドウ内の翻訳テスト', stime: 4.5 },
  { sourceId: '987654323', text: '窗口外不应翻译', translated: 'OUTSIDE_MUST_NOT_BE_REQUESTED', stime: 5.25 },
];
const translations = new Map(rows.map(row => [row.text, row.translated]));
// Complete the fixture's reviewed native manager surface and retain source identity.
const reportFilterSource = 'function(n){var r;return null!=(r=this.reportFilter)&&!!r.length&&this.reportFilter.some(function(r){if(new RegExp(r).test(n.text))return!0})}';
const aiJudgeSource = 'function(n,r){return this.totalFiltleredDm+=1,Math.abs(n.weight)<r&&(this.aiCloudBlockCount+=1,!0)}';
const blockMap = {
  blockScroll: [1], blockTopBottom: [5, 4],
  blockColor: [2012, 2015, 2007, 2008, 2009, 2013, 2002, 2003, 2000, 2001, 2004, 5, 4, 1, 6],
  blockSpecial: [2005, 2012, 2015, 2002, 2003, 2000, 2001, 2004, 2006, 2013, 2008, 2009, 2011, 2007, 2014, 2010, 3000, 2016, 2017, 2018, 2020],
  preventShade: [4],
};
const contract = `
  const startupDm = window.player.danmaku.getDanmakuX(), startupManager = startupDm.manager;
  const nativeFunction = source => new Function('return (' + source + ')')();
  const dmSettingStore = { state: { status: true, dmarea: 50, dmdensity: 1,
    typeScroll: true, typeTopBottom: true, typeColor: true, typeSpecial: true,
    seniorMode: false, preventshade: false } };
  const blockStore = { blockList: [], reportFilter: [],
    reportFilterReg: nativeFunction(${JSON.stringify(reportFilterSource)}),
    aiJudge: nativeFunction(${JSON.stringify(aiJudgeSource)}),
    DmBlockMap: ${JSON.stringify(blockMap)}, dmMap: new Map(), dmSettingStore };
  for (const [name, source] of Object.entries(${JSON.stringify(USER_FILTER_NATIVE_FUNCTIONS)}))
    blockStore[name] = nativeFunction(source);
  window.player.rootStore = { rootPlayer: window.player,
    danmakuStore: { danmakuX: startupDm }, blockStore, dmSettingStore };
  const startupSetting = { visible: true, area: 100, fontSize: 1, limit: 300, preTime: 1,
    noDanmakuXTypes: [] };
  startupDm.config = startupManager.config = { setting: startupSetting,
    scene: { isMini: false }, fn: { filter: nativeFunction(${JSON.stringify(USER_FILTER_NATIVE_CALLBACK)}) } };
  startupDm.isRunning = true;
  startupDm.timeController = { renderTime: 0, lastFetchDmTime: 0 };
  window.__PLANNED_CLEAR_CALLS__ = 0;
  startupDm.clear = () => { window.__PLANNED_CLEAR_CALLS__++; startupManager.visualArray.length = 0; stage.replaceChildren(); };
  startupManager.container = document.querySelector('#playerWrap');
  startupManager.containerSize = { width: 720, height: 360 };
  startupManager.dataBase.timeLine = { list: startupManager.dataBase.dmArray };
  for (const row of startupManager.dataBase.dmArray) {
    delete row.on; // Real parser output has no lifecycle property before admission.
    row.uhash = 'fixture-author-' + row.dmid;
    row.weight = 20; row.border = false; row.colorful = false;
  }
  startupManager.dataBase.timeLine.list = structuredClone(startupManager.dataBase.dmArray);
  startupManager.cDmlist = []; startupManager.lastTime = 0;
  startupManager.validate = () => true;
  startupManager.insert = function(pending) {
    history.insertCalls++;
    startupDm.hooks.beforeRender.call(this, this.visualArray.slice(), pending.slice());
    const before = history.renders.length;
    for (const row of pending) {
      if (!row || !this.validate(row) || row.on) continue;
      row.on = true; this.initRender(row);
    }
    const measured = history.renders.slice(before).map(row => row.text);
    history.measurements.push({ at: performance.now(), ids: pending.map(row => String(row?.dmid ?? '')), measured });
    return { measured };
  };
  // Track the completed fixture's baseline, before the extension wraps it.
  history.players.at(-1).insert = startupManager.insert;
  startupManager.fetchAndInitDm = function(render) {
    this.lastTime = render + startupSetting.preTime;
    this.insert(this.dataBase.dmArray.filter(row => row.stime >= render && row.stime < this.lastTime));
    startupDm.timeController.lastFetchDmTime = render;
  };
  const mainVideo = document.querySelector('#fixture-video');
  // The fixture deliberately has no media URL; expose the ready state of its
  // synthetic clock to the real planner without loading any external media.
  Object.defineProperty(mainVideo, 'readyState', { configurable: true, get: () => 4 });
  const originalTime = Object.getOwnPropertyDescriptor(mainVideo, 'currentTime');
  const originalRate = Object.getOwnPropertyDescriptor(mainVideo, 'playbackRate');
  window.__PLANNED_MAIN_WRITES__ = { currentTime: 0, playbackRate: 0 };
  Object.defineProperty(mainVideo, 'currentTime', { configurable: true,
    get: originalTime.get, set(value) { window.__PLANNED_MAIN_WRITES__.currentTime++; originalTime.set.call(this, value); } });
  Object.defineProperty(mainVideo, 'playbackRate', { configurable: true,
    get: originalRate.get, set(value) { window.__PLANNED_MAIN_WRITES__.playbackRate++; originalRate.set.call(this, value); } });
`;
let fixture = videoHtml.replace('  window.__BILI_FIXTURE__ = {',
  `window.__INSTALL_PLANNED_CONTRACT__ = () => { ${contract} }; window.__INSTALL_PLANNED_CONTRACT__();\n  window.__BILI_FIXTURE__ = {`);
assert.notEqual(fixture, videoHtml);

// Keep one current five-second window and one explicit outside-window row.
fixture = fixture.replace('  window.__BILI_FIXTURE__ = {', `
  startupRows();
  function startupRows() {
    const manager = window.player.danmaku.getDanmakuX().manager;
    manager.dataBase.dmArray.splice(0, manager.dataBase.dmArray.length,
      ...${JSON.stringify(rows)}.map(row => ({ dmid: row.sourceId, id_str: row.sourceId,
        text: row.text, stime: row.stime, mode: 1, rawMode: 1, size: 25, color: 16777215,
        pool: 0, uhash: 'fixture-author-' + row.sourceId, weight: 20, border: false, colorful: false })));
    manager.dataBase.timeLine.list = structuredClone(manager.dataBase.dmArray);
  }
  window.__BILI_FIXTURE__ = {`);

let activeScenario;
const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404, { 'content-type': 'application/json' }); response.end('{}'); return;
  }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  try {
    const body = JSON.parse(raw);
    const user = body.messages.find(message => message.role === 'user')?.content ?? '';
    let input, content;
    if (user.trim().startsWith('{')) {
      input = JSON.parse(user).items;
      content = JSON.stringify({ items: input.map(row => ({ id: row.id, text: translations.get(row.text) ?? 'UNKNOWN_FIXTURE_INPUT' })) });
    } else {
      input = user.trim().split('\n').map(line => JSON.parse(line));
      content = input.map(([id, text]) => JSON.stringify([id, translations.get(text) ?? 'UNKNOWN_FIXTURE_INPUT'])).join('\n');
      input = input.map(([id, text]) => ({ id, text }));
    }
    // Record only known fixture text and protocol fields. No headers or credentials.
    activeScenario.requests.push({ at: Date.now(), path: request.url, stream: body.stream === true,
      input: input.map(row => ({ id: row.id, fixtureSourceId: rows.find(item => item.text === row.text)?.sourceId ?? null,
        knownFixtureText: translations.has(row.text) })) });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
  } catch (error) {
    activeScenario?.errors.push('fixture-provider:' + error.message);
    response.writeHead(500, { 'content-type': 'application/json' }); response.end('{}');
  }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
const { chromium } = await loadPlaywright();

function installClock(offset) {
  if (!globalThis.__PLANNED_REAL_DATE_NOW__) globalThis.__PLANNED_REAL_DATE_NOW__ = Date.now.bind(Date);
  Date.now = () => globalThis.__PLANNED_REAL_DATE_NOW__() + offset;
  return { offset, dateNow: Date.now(), performanceStamp: performance.timeOrigin + performance.now(),
    realDateNow: globalThis.__PLANNED_REAL_DATE_NOW__(), timeOrigin: performance.timeOrigin };
}

async function runScenario(offset, hybridStale = false) {
  const scenario = { name: hybridStale ? 'hybrid-stale-capacity' : offset === 0 ? 'default' : `wall-offset-${offset}`, offset,
    checks: [], requests: [], errors: [], blockedHttp: [], screenshots: [], status: 'RUNNING' };
  activeScenario = scenario;
  report.scenarios.push(scenario);
  let context, page, cdp, extensionWorld, settingsPage, worker;
  const worlds = [];
  const safeMessage = message => ({ requestId: message.requestId, configVersion: message.configVersion,
    sentAt: message.sentAt, resourceId: message.resourceId, planning: message.planning,
    session: message.session, items: message.items?.map(item => ({ id: item.id, sourceId: item.sourceId,
      epoch: item.epoch, predictionEpoch: item.predictionEpoch, ruleRevision: item.ruleRevision,
      configIdentity: item.configIdentity, deadlineAtEpochMs: item.deadlineAtEpochMs, remainingMs: item.remainingMs })) });
  const worldValue = async expression => {
    const result = await cdp.send('Runtime.evaluate', { contextId: extensionWorld.id,
      expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description);
    return result.result.value;
  };
  const capture = async () => {
    if (!page || page.isClosed()) return;
    scenario.wire = await page.evaluate(() => ({ controls: window.__PLANNED_CONTROL__,
      lists: window.__PLANNED_LISTS__, prepared: window.__PLANNED_PREPARED__,
      sources: window.__PLANNED_SOURCE_PACKETS__.map(packet => ({ session: packet.session,
        revision: packet.revision, upserts: packet.upserts?.map(row => ({ id: row.id, sourceId: row.sourceId, mediaTimeMs: row.mediaTimeMs })) })),
      sourceAcks: window.__PLANNED_SOURCE_ACKS__ }));
    if (extensionWorld) {
      const messages = await worldValue('window.__PLANNED_TRANSPORT__');
      scenario.messages = messages.map(entry => ({ ...entry, message: safeMessage(entry.message) }));
    }
    if (worker) scenario.backgroundMessages = await worker.evaluate(() => globalThis.__PLANNED_BG_MESSAGES__);
  };
  try {
    if (hybridStale) {
      await installUnloadedLocalFixture();
      scenario.localEvidence = 'MOCK_REGISTERED_MODELS_AND_UNLOADED_STATE_NO_REAL_GPU_OR_MODEL';
    }
    context = await chromium.launchPersistentContext(resolve(directory, scenario.name, 'profile'), {
      ...browserLaunchOptions('edge'), headless: true, viewport: { width: 1100, height: 920 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        '--disable-background-networking', '--no-first-run',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
    });
    context.setDefaultTimeout(12000);
    await context.route(/^https?:/, route => {
      const url = route.request().url();
      if (url === FIRST_URL) return route.fulfill({ contentType: 'text/html', body: fixture });
      if (url.startsWith(endpoint + '/')) return route.continue();
      scenario.blockedHttp.push(url); return route.abort();
    });
    worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    scenario.workerClock = await worker.evaluate(installClock, offset);
    await worker.evaluate(() => {
      globalThis.__PLANNED_BG_MESSAGES__ = [];
      chrome.runtime.onMessage.addListener(message => {
        if (message?.type !== 'translate' || !message.planning) return;
        globalThis.__PLANNED_BG_MESSAGES__.push({ requestId: message.requestId,
          receivedPerformanceStamp: performance.timeOrigin + performance.now(), receivedDateNow: Date.now(),
          configVersion: message.configVersion, sentAt: message.sentAt, planning: message.planning,
          items: message.items.map(item => ({ id: item.id, sourceId: item.sourceId, epoch: item.epoch,
            predictionEpoch: item.predictionEpoch, ruleRevision: item.ruleRevision, configIdentity: item.configIdentity,
            deadlineAtEpochMs: item.deadlineAtEpochMs, remainingMs: item.remainingMs })) });
      });
    });
    const extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
    settingsPage = await context.newPage();
    await settingsPage.goto(`${extensionOrigin}/options.html`);
    const initial = await settingsPage.evaluate(() => chrome.runtime.sendMessage({ type: 'settings' }));
    const disabledSettings = { ...initial.settings, enabled: false, displayMode: 'translated', backend: 'online',
      endpoint, endpointInput: endpoint, allowLocalHttp: true, model: 'fixture-model', sourceLanguage: 'auto', targetLanguage: 'ja',
      profile: 'chat-completions', reasoningProfileOverride: 'auto', translationStream: false,
      localPreloadOnEntry: false, bilibiliOwnedRelease: true, bilibiliNativeTranslationOnly: false,
      bilibiliShadowScheduler: false, bilibiliHybrid: { ...initial.settings.bilibiliHybrid, enabled: false } };
    const save = changes => settingsPage.evaluate(async changes => {
      const current = await chrome.runtime.sendMessage({ type: 'settings' });
      return chrome.runtime.sendMessage({ type: 'save', settings: { ...current.settings, ...changes }, apiKey: 'fixture-key', remember: false });
    }, changes);
    let saved = await save(disabledSettings);
    assert.equal(saved.ok, true, saved.error);
    await worker.evaluate(() => chrome.storage.local.set({ 'ui.locale.v1': 'zh-CN', 'ui.preferences.v1': { theme: 'light' } }));
    if (hybridStale) {
      const selectedOld = await settingsPage.evaluate(modelId => chrome.runtime.sendMessage({ type: 'select-local-model', modelId }), fixtureModels[0]);
      assert.equal(selectedOld.ok, true, selectedOld.error);
      const oldCapacity = await settingsPage.evaluate(async () => {
        const current = await chrome.runtime.sendMessage({ type: 'settings' });
        return chrome.runtime.sendMessage({ type: 'hybrid-capacity', settings: current.settings });
      });
      assert.equal(oldCapacity.ok, true, oldCapacity.error);
      assert.match(oldCapacity.identity, /^[a-f0-9]{64}$/);
      saved = await save({ enabled: true, bilibiliHybrid: { enabled: true, adaptive: false, onlineStreaming: false,
        profiles: [{ identity: oldCapacity.identity, maxItems: 2, maxChars: 512, manual: true }] } });
      assert.equal(saved.ok, true, saved.error);
      // The real immediate-selection write retains the old capacity profile.
      // No video tab exists yet, so neither old nor new model can translate.
      const selectedNew = await settingsPage.evaluate(modelId => chrome.runtime.sendMessage({ type: 'select-local-model', modelId }), fixtureModels[1]);
      assert.equal(selectedNew.ok, true, selectedNew.error);
      assert.equal(selectedNew.settings.enabled, true);
      assert.equal(selectedNew.settings.bilibiliHybrid.enabled, true);
      assert.equal(selectedNew.settings.localModelId, fixtureModels[1]);
      assert.deepEqual(selectedNew.settings.bilibiliHybrid.profiles, saved.settings.bilibiliHybrid.profiles);
      scenario.modelSwitch = { from: fixtureModels[0], to: selectedNew.settings.localModelId,
        enabled: selectedNew.settings.enabled, hybrid: selectedNew.settings.bilibiliHybrid.enabled,
        retainedCapacityIdentity: oldCapacity.identity, operation: 'REAL_SELECT_LOCAL_MODEL_NO_LOAD' };
      saved = await settingsPage.evaluate(() => chrome.runtime.sendMessage({ type: 'toggle', enabled: false }));
      assert.equal(saved.ok, true, saved.error);
      assert.equal(scenario.requests.length, 0);
      scenario.checks.push('real-model-selection-keeps-enabled-hybrid-old-capacity-profile');
    }
    scenario.config = { backend: saved.settings.backend, sourceLanguage: saved.settings.sourceLanguage,
      targetLanguage: saved.settings.targetLanguage, enabled: saved.settings.enabled,
      bilibiliOwnedRelease: saved.settings.bilibiliOwnedRelease, hybrid: saved.settings.bilibiliHybrid?.enabled };
    page = await context.newPage();
    page.on('pageerror', error => scenario.errors.push(error.message));
    cdp = await context.newCDPSession(page);
    cdp.on('Runtime.executionContextCreated', ({ context }) => worlds.push(context));
    await cdp.send('Runtime.enable');
    await page.addInitScript(installClock, offset);
    await page.addInitScript(() => {
      window.__PLANNED_LISTS__ = []; window.__PLANNED_PREPARED__ = [];
      window.__PLANNED_SOURCE_PACKETS__ = []; window.__PLANNED_SOURCE_ACKS__ = [];
      window.addEventListener('message', event => {
        const value = event.data;
        if (value?.bridge !== 'danlingo.native.v1') return;
        if (value.type === 'sources') window.__PLANNED_SOURCE_PACKETS__.push(value);
        if (value.type === 'sources-ack') window.__PLANNED_SOURCE_ACKS__.push(value);
        if (value.type === 'prepared' && value.from === 'content') window.__PLANNED_PREPARED__.push(value);
        if (value.type === 'control' && value.from === 'content') window.__PLANNED_CONTROL__ = value;
        if (value.type === 'bilibili-shadow' && value.from === 'native' && value.policy === 'owned') window.__PLANNED_LISTS__.push(value);
      });
    });
    await page.goto(FIRST_URL);
    await page.waitForFunction(() => document.querySelector('#danlingo-disabled-notice'));
    extensionWorld = worlds.find(world => world.origin === extensionOrigin);
    assert.ok(extensionWorld, 'built extension isolated content world is required');
    scenario.contentClock = await worldValue(`(${installClock.toString()})(${offset})`);
    await worldValue(`(() => {
      window.__PLANNED_TRANSPORT__ = []; window.__PLANNED_HARNESS_IDS__ = new Set();
      const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = function(...args) {
        const message = args[0], planned = message?.type === 'translate' && !!message.planning;
        const entry = planned ? { message: structuredClone(message),
          sentDateNow: Date.now(), sentPerformanceStamp: performance.timeOrigin + performance.now(),
          mediaTime: document.querySelector('video')?.currentTime,
          harness: window.__PLANNED_HARNESS_IDS__.has(message.requestId) } : null;
        if (entry) window.__PLANNED_TRANSPORT__.push(entry);
        const accept = response => { if (entry) entry.response = { ok: response?.ok, error: response?.error,
          errorMessage: response?.errorMessage, hybridStats: response?.hybridStats,
          items: response?.items?.map(item => ({ id: item.id, status: item.status, reason: item.reason })) }; return response; };
        if (typeof args.at(-1) === 'function') { const callback = args.at(-1); args[args.length - 1] = response => callback(accept(response)); }
        const result = originalSend(...args);
        return result?.then ? result.then(accept) : result;
      };
      const video = document.querySelector('video');
      const writes = window.__PLANNED_EXTENSION_WRITES__ = { pause: 0, play: 0, currentTime: 0, playbackRate: 0 };
      const time = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
      const rate = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
      Object.defineProperty(video, 'duration', { configurable: true, get: () => 600 });
      Object.defineProperty(video, 'currentTime', { configurable: true,
        get() { return time.get.call(this); }, set(value) { writes.currentTime++; time.set.call(this, value); } });
      Object.defineProperty(video, 'playbackRate', { configurable: true,
        get() { return rate.get.call(this); }, set(value) { writes.playbackRate++; rate.set.call(this, value); } });
      const pause = video.pause, play = video.play;
      video.pause = function() { writes.pause++; return pause.call(this); };
      video.play = function() { writes.play++; return play.call(this); };
    })()`);
    scenario.mainClock = await page.evaluate(() => ({ dateNow: Date.now(), realDateNow: window.__PLANNED_REAL_DATE_NOW__(),
      performanceStamp: performance.timeOrigin + performance.now(), timeOrigin: performance.timeOrigin }));
    for (const clock of [scenario.workerClock, scenario.contentClock, scenario.mainClock]) {
      assert.ok(Math.abs(clock.dateNow - clock.realDateNow - offset) < 20, 'Date.now offset must be applied');
      assert.ok(Math.abs(clock.realDateNow - clock.performanceStamp) < 100, 'native performance epoch is unchanged');
    }
    const pageStatus = () => settingsPage.evaluate(async url => {
      const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
      return tab ? chrome.tabs.sendMessage(tab.id, { type: 'bilibili-native-supply', action: 'status' }) : null;
    }, FIRST_URL);
    const ui = () => page.locator('#danlingo-progress').evaluate(host => {
      const root = host.shadowRoot, supply = root?.querySelector('#native-supply-host');
      const value = id => root?.querySelector('#' + id)?.textContent?.trim() ?? '';
      return { label: supply?.textContent?.trim(), note: value('note'),
        state: value('native-supply-status'), reason: value('native-supply-reason'),
        selected: value('supply-selected'), submitted: value('supply-submitted'), ready: value('supply-ready'), adopted: value('supply-adopted'),
        hybridLocalRequests: value('hybrid-local-requests'), hybridOnlineRequests: value('hybrid-online-requests') };
    });
    const media = async () => ({ main: await page.evaluate(() => ({ paused: window.__BILI_FIXTURE__.state.paused,
      mediaTime: window.__BILI_FIXTURE__.state.time, pause: window.__BILI_FIXTURE__.history.pauseCalls,
      play: window.__BILI_FIXTURE__.history.playCalls, ...window.__PLANNED_MAIN_WRITES__, clear: window.__PLANNED_CLEAR_CALLS__ })),
      content: await worldValue('window.__PLANNED_EXTENSION_WRITES__') });
    const screenshot = async name => {
      const path = resolve(directory, scenario.name, `${name}.png`);
      await page.screenshot({ path }); scenario.screenshots.push(path);
    };
    const waitStatus = async (accept, label) => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const value = await pageStatus().catch(() => null);
        if (value && accept(value)) return value;
        await page.waitForTimeout(150);
      }
      scenario.failedWait = { label, status: await pageStatus().catch(() => null) };
      throw new Error('planned status did not reach ' + label);
    };
    scenario.playbackBefore = await media();
    const enabled = hybridStale
      ? await settingsPage.evaluate(() => chrome.runtime.sendMessage({ type: 'toggle', enabled: true }))
      : await save({ enabled: true });
    assert.equal(enabled.ok, true, enabled.error);
    // The normal save invalidates the source generation. Re-enter the synthetic
    // page after enabling so its native source publisher supplies that generation.
    await page.evaluate(() => window.__BILI_FIXTURE__.spaDisableEnable());
    if (hybridStale) {
      await page.waitForFunction(expected => document.querySelector('#danlingo-progress')?.shadowRoot?.querySelector('#note')?.textContent?.trim() === expected,
        capacityError, { timeout: 8000 });
      const summary = page.locator('#danlingo-progress').locator('#progress-details > summary');
      if (!await summary.evaluate(element => element.parentElement.open)) await summary.click();
      await capture();
      const rejected = scenario.messages.filter(entry => !entry.harness && entry.response?.ok === false);
      assert.ok(rejected.some(entry => entry.response.error === capacityError && entry.response.errorMessage?.id === 'm_110c7749641a'),
        'the real background must return the existing localized capacity error');
      scenario.staleCapacity = { providerRequests: scenario.requests.length, ui: await ui(),
        status: await pageStatus(), rejections: rejected.map(entry => entry.response) };
      assert.equal(scenario.staleCapacity.ui.note, capacityError);
      assert.equal(scenario.staleCapacity.providerRequests, 0, 'stale capacity cannot reach the provider');
      assert.equal(scenario.wire.prepared.flatMap(packet => packet.items ?? []).length, 0);
      assert.deepEqual(await media(), scenario.playbackBefore, 'capacity rejection cannot change playback');
      await screenshot('hybrid-stale-capacity-error');
      scenario.checks.push('stale-capacity-exact-localized-ui-error-provider-zero');

      const currentCapacity = await settingsPage.evaluate(async () => {
        const current = await chrome.runtime.sendMessage({ type: 'settings' });
        return chrome.runtime.sendMessage({ type: 'hybrid-capacity', settings: current.settings });
      });
      assert.equal(currentCapacity.ok, true, currentCapacity.error);
      assert.match(currentCapacity.identity, /^[a-f0-9]{64}$/);
      assert.notEqual(currentCapacity.identity, scenario.modelSwitch.retainedCapacityIdentity);
      assert.equal(currentCapacity.profile, undefined, 'the retained old profile cannot match the new model');
      const repaired = await settingsPage.evaluate(async identity => {
        const current = await chrome.runtime.sendMessage({ type: 'settings' });
        return chrome.runtime.sendMessage({ type: 'save', settings: { ...current.settings,
          bilibiliHybrid: { ...current.settings.bilibiliHybrid, profiles: [...current.settings.bilibiliHybrid.profiles,
            { identity, maxItems: 2, maxChars: 512, manual: true }] } }, apiKey: 'fixture-key', remember: false });
      }, currentCapacity.identity);
      assert.equal(repaired.ok, true, repaired.error);
      assert.equal(repaired.settings.localModelId, fixtureModels[1]);
      scenario.capacityRepair = { identity: currentCapacity.identity, enabled: repaired.settings.enabled,
        hybrid: repaired.settings.bilibiliHybrid.enabled,
        profile: repaired.settings.bilibiliHybrid.profiles.find(profile => profile.identity === currentCapacity.identity),
        operation: 'REAL_HYBRID_CAPACITY_THEN_REAL_SAVE', samePage: page.url() === FIRST_URL };
      assert.equal(scenario.capacityRepair.profile.manual, true);
      assert.equal(scenario.capacityRepair.samePage, true);
      await page.evaluate(() => window.__BILI_FIXTURE__.spaDisableEnable());
      scenario.checks.push('current-capacity-identity-and-manual-limits-saved-with-official-messages');
    }
    await waitStatus(value => value.submittedInputs > 0 || value.report?.ready > 0, 'paused window submitted');
    const prepared = await page.waitForFunction(() => {
      const ids = new Set(window.__PLANNED_PREPARED__.flatMap(packet => packet.items ?? []).map(item => item.sourceId));
      return ids.has('987654321') && ids.has('987654322');
    }, undefined, { timeout: 8000 }).then(() => true).catch(() => false);
    if (prepared) await waitStatus(value => value.report?.ready >= 2, 'native accepted prepared text');
    const summary = page.locator('#danlingo-progress').locator('#progress-details > summary');
    if (!await summary.evaluate(element => element.parentElement.open)) await summary.click();
    await page.waitForFunction(() => document.querySelector('#danlingo-progress')?.shadowRoot?.querySelector('#supply-submitted')?.textContent?.trim() === '2',
      undefined, { timeout: 1500 }).catch(() => {});
    await capture();
    scenario.pausedStatus = await pageStatus(); scenario.pausedUi = await ui();
    scenario.playbackWhilePaused = await media();
    await screenshot('paused-request-and-prepared');
    assert.ok(scenario.requests.length > 0, 'paused current window must make a real loopback provider request');
    assert.ok(scenario.wire.prepared.some(packet => packet.items?.some(item => item.sourceId === rows[0].sourceId && item.text === rows[0].translated)),
      'successful provider response must become ordinary prepared wire');
    assert.equal(scenario.playbackWhilePaused.main.paused, true);
    assert.deepEqual(scenario.playbackWhilePaused.main, scenario.playbackBefore.main, 'paused preparation cannot write playback state');
    assert.deepEqual(scenario.playbackWhilePaused.content, scenario.playbackBefore.content, 'content cannot write playback state');
    for (const request of scenario.requests) {
      assert.equal(request.stream, false); assert.ok(request.input.length > 0);
      assert.ok(request.input.every(item => item.knownFixtureText && ['987654321', '987654322'].includes(item.fixtureSourceId)),
        'only the current five-second native window may be sent');
    }
    scenario.checks.push('paused-current-five-seconds-provider-to-prepared', 'no-outside-window-provider-input', 'no-playback-writes-while-preparing');
    if (hybridStale) {
      const lanes = scenario.pausedStatus.hybridStats;
      assert.ok(lanes, 'successful hybrid translation must expose the real engine lane statistics');
      assert.equal(lanes.local.actualRequests, 0);
      assert.ok(lanes.online.actualRequests > 0);
      assert.equal(lanes.online.actualRequests, scenario.requests.length);
      assert.equal(lanes.online.inputItems, 2);
      assert.notEqual(scenario.pausedUi.note, capacityError, 'the capacity error must clear after saving matching limits');
      scenario.hybridLanes = lanes;
      scenario.checks.push('unloaded-local-model-uses-legitimate-online-overflow-lane');
    }

    const requestsBeforeGuard = scenario.requests.length;
    scenario.deadlineGuard = await worldValue(`(async () => {
      const captured = window.__PLANNED_TRANSPORT__.findLast(entry => !entry.harness && entry.response?.ok === true).message;
      const requestId = crypto.randomUUID(); window.__PLANNED_HARNESS_IDS__.add(requestId);
      return chrome.runtime.sendMessage({ ...captured, requestId, sentAt: Date.now(),
        items: captured.items.map(item => ({ ...item, deadlineAtEpochMs: Date.now() + 120000, remainingMs: 1000 })) });
    })()`);
    assert.equal(scenario.deadlineGuard.ok, false); assert.equal(scenario.deadlineGuard.error, '无效计划批次');
    assert.equal(scenario.requests.length, requestsBeforeGuard, 'malformed deadline must not reach provider');
    scenario.checks.push('malformed-deadline-remains-rejected-before-provider');

    await page.evaluate(() => window.__BILI_FIXTURE__.play());
    await waitStatus(value => value.state === 'running', 'resume');
    const beforeAdopt = await media();
    // Advance the synthetic media clock as playback, without a seek event.
    for (const time of [0.75, 1.5, 2.25, 3]) await page.evaluate(value => { window.__BILI_FIXTURE__.state.time = value; }, time);
    await page.evaluate(() => window.player.danmaku.getDanmakuX().manager.fetchAndInitDm(3));
    const visible = page.locator('#danmaku-stage [data-dmid="987654321"]');
    await visible.waitFor({ state: 'visible' });
    assert.equal(await visible.textContent(), rows[0].translated);
    scenario.nativeAdoption = await page.evaluate(() => {
      const manager = window.player.danmaku.getDanmakuX().manager;
      const original = manager.dataBase.timeLine.list.find(row => row.dmid === '987654321');
      const model = manager.visualArray.find(row => row.textData.dmid === '987654321');
      const node = document.querySelector('#danmaku-stage [data-dmid="987654321"]');
      const rect = node.getBoundingClientRect(), container = manager.container.getBoundingClientRect();
      return { original: original.text, originalAuthor: original.uhash, modelText: model.text,
        modelAuthor: model.textData.uhash, on: original.on,
        visible: rect.width > 0 && rect.height > 0 && rect.left < container.right && rect.right > container.left && rect.top < container.bottom && rect.bottom > container.top };
    });
    assert.equal(scenario.nativeAdoption.original, rows[0].text);
    assert.equal(scenario.nativeAdoption.modelText, rows[0].translated);
    assert.equal(scenario.nativeAdoption.originalAuthor, scenario.nativeAdoption.modelAuthor);
    assert.equal(scenario.nativeAdoption.visible, true);
    const afterAdopt = await media();
    for (const key of ['pause', 'play', 'currentTime', 'playbackRate', 'clear']) assert.equal(afterAdopt.main[key], beforeAdopt.main[key], 'MAIN adoption write: ' + key);
    assert.deepEqual(afterAdopt.content, beforeAdopt.content, 'content cannot write playback on adoption');
    scenario.adoptedStatus = await waitStatus(value => (value.report?.counts?.adopted ?? 0) > 0, 'native adoption');
    await page.waitForFunction(() => document.querySelector('#danlingo-progress')?.shadowRoot?.querySelector('#supply-adopted')?.textContent?.trim() === '1');
    scenario.adoptedUi = await ui(); await screenshot('native-adopted-visible');
    scenario.checks.push('ordinary-prepared-is-adopted-on-resume-with-native-source-identity', 'no-playback-writes-on-adoption');
    const local = await settingsPage.evaluate(() => chrome.runtime.sendMessage({ type: 'local-control', control: { action: 'state' } }));
    scenario.localState = { phase: local.state?.phase, inferenceCalls: local.state?.inferenceCalls ?? 0 };
    if (hybridStale) {
      scenario.localFixture = local.fixtureTrace;
      assert.equal(scenario.localFixture.completeAttempts, 0, 'the mock must receive no local completion IPC');
      assert.equal(scenario.localFixture.inferenceCalls, 0);
      scenario.checks.push('synthetic-models-never-load-weights-or-run-local-inference');
    }
    assert.equal(scenario.localState.inferenceCalls, 0); assert.deepEqual(scenario.errors, []);
    scenario.status = 'PASS';
  } catch (error) {
    scenario.status = 'FAIL'; scenario.failure = error.stack ?? String(error);
    if (page && !page.isClosed()) {
      const path = resolve(directory, scenario.name, 'failure.png');
      await page.screenshot({ path }).then(() => scenario.screenshots.push(path)).catch(() => {});
    }
  } finally {
    await capture().catch(error => { scenario.captureError = error.message; });
    await context?.close();
    await writeFile(resolve(directory, scenario.name, 'report.json'), JSON.stringify(scenario, null, 2));
    console.log('SCENARIO', JSON.stringify({ name: scenario.name, status: scenario.status, requests: scenario.requests.length,
      failure: scenario.failure?.split('\n')[0], errors: scenario.errors,
      rejections: scenario.messages?.filter(entry => !entry.harness && entry.response?.ok === false).map(entry => entry.response.error),
      report: resolve(directory, scenario.name, 'report.json') }));
  }
}

try {
  for (const offset of [0, 5000, -5000]) {
    const name = offset === 0 ? 'default' : `wall-offset-${offset}`;
    if (!selectedScenario || selectedScenario === name) await runScenario(offset);
  }
  if (!selectedScenario || selectedScenario === 'hybrid-stale-capacity') await runScenario(0, true);
  report.passed = report.scenarios.every(scenario => scenario.status === 'PASS');
  if (!report.passed) process.exitCode = 1;
} finally {
  await new Promise(done => server.close(done));
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log('REPORT', resolve(directory, 'report.json'));
}

