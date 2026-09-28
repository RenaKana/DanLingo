// Isolated built extension and synthetic player; no account, model or external HTTP.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadPlaywright, browserLaunchOptions } from './browser-runtime.mjs';
import { FIRST_URL, videoHtml } from '../test/fixtures/bilibili-video-native.mjs';
import { USER_FILTER_NATIVE_CALLBACK, USER_FILTER_NATIVE_FUNCTIONS } from '../src/platforms/bilibili/user-filter-contract.ts';

const extension = resolve(process.env.DANLINGO_TEST_EXTENSION || '../DanLingo-Workspace/testing/current/extension');
const root = resolve('.artifacts/bilibili-owned-startup');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(resolve(root, 'run-'));
const identity = JSON.parse(await readFile(resolve(extension, 'runtime-identity.json'), 'utf8'));
const source = JSON.parse(await readFile('package.json', 'utf8'));
assert.equal(identity.version, source.version, 'test extension must match the current source version');
const report = { evidence: 'ISOLATED_BUILT_EXTENSION_SYNTHETIC_PLAYER_UNREGISTERED_LOCAL_MODEL',
  identity, directory, checks: [], errors: [], blockedHttp: [], screenshots: [], passed: false };

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
const fixture = videoHtml.replace('  window.__BILI_FIXTURE__ = {',
  `window.__INSTALL_PLANNED_CONTRACT__ = () => { ${contract} }; window.__INSTALL_PLANNED_CONTRACT__();\n  window.__BILI_FIXTURE__ = {`);
assert.notEqual(fixture, videoHtml);

const { chromium } = await loadPlaywright();
const context = await chromium.launchPersistentContext(resolve(directory, 'profile'), {
  ...browserLaunchOptions(), headless: true, viewport: { width: 1100, height: 920 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
  await context.route(/^https?:/, route => {
    if (route.request().url() === FIRST_URL) return route.fulfill({ contentType: 'text/html', body: fixture });
    report.blockedHttp.push(route.request().url());
    return route.abort();
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
  const settingsPage = await context.newPage();
  await settingsPage.goto(`${extensionOrigin}/options.html`);
  const initial = await settingsPage.evaluate(() => chrome.runtime.sendMessage({ type: 'settings' }));
  await worker.evaluate(async settings => chrome.storage.local.set({
    'ui.locale.v1': 'zh-CN', 'settings.v1': { ...settings, enabled: true, displayMode: 'translated',
      backend: 'local', localPreloadOnEntry: false, localModelId: 'unregistered-planned-fixture',
      bilibiliOwnedRelease: true, bilibiliNativeTranslationOnly: false, bilibiliShadowScheduler: false,
      targetLanguage: 'ja', sourceLanguage: 'auto' },
  }), initial.settings);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page), worlds = [];
  cdp.on('Runtime.executionContextCreated', ({ context }) => worlds.push(context));
  await cdp.send('Runtime.enable');
  page.on('pageerror', error => report.errors.push(error.message));
  await page.addInitScript(() => {
    window.__PLANNED_SNAPSHOTS__ = [];
    window.__PLANNED_LISTS__ = [];
    window.__PLANNED_SOURCE_PACKETS__ = [];
    window.__PLANNED_SOURCE_ACKS__ = [];
    window.addEventListener('message', event => {
      if (event.data?.bridge === 'danlingo.native.v1' && event.data.type === 'sources')
        window.__PLANNED_SOURCE_PACKETS__.push(event.data);
      if (event.data?.bridge === 'danlingo.native.v1' && event.data.type === 'sources-ack')
        window.__PLANNED_SOURCE_ACKS__.push(event.data);
      if (event.data?.bridge === 'danlingo.native.v1' && event.data.from === 'content' &&
          event.data.type === 'control') window.__PLANNED_CONTROL__ = event.data;
      if (event.data?.bridge === 'danlingo.native.v1' && event.data.from === 'native' &&
          event.data.type === 'bilibili-shadow' && event.data.policy === 'owned') window.__PLANNED_LISTS__.push(event.data);
      if (event.data?.bridge === 'danlingo.native.v1' && event.data.from === 'native' &&
          event.data.type === 'snapshot') window.__PLANNED_SNAPSHOTS__.push(event.data);
    });
  });
  await page.goto(FIRST_URL);
  await page.waitForFunction(() => document.querySelector('#danlingo-progress')?.shadowRoot
    ?.querySelector('#native-supply-host')?.textContent?.includes('提前5秒规划'));
  const extensionWorld = worlds.find(world => world.origin === extensionOrigin);
  assert.ok(extensionWorld, 'built extension isolated world must be identified');
  const instrument = await cdp.send('Runtime.evaluate', { contextId: extensionWorld.id,
    expression: `(() => {
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
      return true;
    })()` });
  assert.equal(instrument.exceptionDetails, undefined);

  const localState = () => settingsPage.evaluate(() => chrome.runtime.sendMessage({
    type: 'local-control', control: { action: 'state' },
  }));
  const pageStatus = () => settingsPage.evaluate(async url => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(entry => entry.url === url);
    return tab ? chrome.tabs.sendMessage(tab.id, { type: 'bilibili-native-supply', action: 'status' }) : null;
  }, page.url());
  async function waitStatus(accept, label) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const status = await pageStatus().catch(() => null);
      if (status && accept(status)) return status;
      await page.waitForTimeout(200);
    }
    report.blockedAt = { label, status: await pageStatus().catch(() => null) };
    throw new Error(`planned status unavailable: ${label}; ${JSON.stringify(report.blockedAt.status)}`);
  }
  const ui = () => page.locator('#danlingo-progress').evaluate(host => {
    const root = host.shadowRoot, supply = root?.querySelector('#native-supply-host');
    const metric = id => supply?.querySelector('#' + id)?.textContent?.trim() ?? '';
    const hybrid = root?.querySelector('#hybrid-details');
    const diagnostics = ['#user-filter-host', '#display-plan-host'].map(id => root?.querySelector(id));
    const notice = host.ownerDocument.getElementById('danlingo-disabled-notice');
    return { label: supply?.textContent?.trim() ?? '', title: metric('native-supply-title'), state: metric('native-supply-status'),
      reason: metric('native-supply-reason'), metrics: { candidates: metric('supply-candidates'), selected: metric('supply-selected'),
        submitted: metric('supply-submitted'), cacheHits: metric('supply-cache-hits'), adopted: metric('supply-adopted'), skipped: metric('supply-skipped'),
        localRequests: metric('hybrid-local-requests'), localTimely: metric('hybrid-local-timely'), onlineRequests: metric('hybrid-online-requests'),
        onlineTimely: metric('hybrid-online-timely'), subscriptions: metric('hybrid-subscriptions') },
      plannedMetricsVisible: root?.querySelector('#supply-metrics')?.hidden === false,
      hybrid: { visible: hybrid?.hidden === false, summary: hybrid?.querySelector('summary')?.textContent?.trim() ?? '',
        scope: metric('hybrid-scope') },
      diagnosticsHidden: diagnostics.length === 2 && diagnostics.every(element => element?.hidden && getComputedStyle(element).display === 'none'),
      disabledNoticeVisible: !!notice?.isConnected && getComputedStyle(notice).display !== 'none',
      visibleSupplyButtons: [...supply?.querySelectorAll('button') ?? []]
      .filter(button => !button.hidden && getComputedStyle(button).display !== 'none')
      .map(button => button.textContent?.trim()), progressVisible: getComputedStyle(host).display !== 'none' };
  });
  const screenshot = async name => {
    const path = resolve(directory, `${name}.png`);
    await page.locator('#danlingo-progress').screenshot({ path }); report.screenshots.push(path);
  };
  async function media() {
    const main = await page.evaluate(() => ({ paused: window.__BILI_FIXTURE__.state.paused,
      pause: window.__BILI_FIXTURE__.history.pauseCalls, play: window.__BILI_FIXTURE__.history.playCalls,
      currentTime: window.__PLANNED_MAIN_WRITES__.currentTime,
      playbackRate: window.__PLANNED_MAIN_WRITES__.playbackRate,
      clear: window.__PLANNED_CLEAR_CALLS__, renders: window.__BILI_FIXTURE__.history.renders.slice() }));
    const result = await cdp.send('Runtime.evaluate', { contextId: extensionWorld.id,
      expression: 'JSON.stringify(window.__PLANNED_EXTENSION_WRITES__)', returnByValue: true });
    assert.equal(result.exceptionDetails, undefined);
    return { main, extension: JSON.parse(result.result.value) };
  }
  function noPlaybackWrites(before, after, label) {
    assert.equal(after.main.paused, false, label);
    for (const key of ['pause', 'play', 'currentTime', 'playbackRate', 'clear'])
      assert.equal(after.main[key], before.main[key], `${label}: MAIN ${key}`);
    for (const key of ['pause', 'play', 'currentTime', 'playbackRate'])
      assert.equal(after.extension[key], before.extension[key], `${label}: isolated ${key}`);
  }
  const save = changes => settingsPage.evaluate(async value => {
    const current = await chrome.runtime.sendMessage({ type: 'settings' });
    return chrome.runtime.sendMessage({ type: 'save', settings: { ...current.settings, ...value } });
  }, changes);
  const fetch = time => page.evaluate(value => {
    const f = window.__BILI_FIXTURE__;
    f.setTime(value);
    window.player.danmaku.getDanmakuX().manager.fetchAndInitDm(value);
  }, time);

  report.localBefore = (await localState()).state;
  // Unreadable history must still fail closed. A readable color-history change
  // must instead be projected without waiting for a native batch to update it.
  await page.evaluate(() => {
    const store = window.player.rootStore.blockStore;
    for (const row of window.player.danmaku.getDanmakuX().manager.dataBase.dmArray) {
      if (![1, 4, 5, 6].includes(row.mode)) continue;
      const entry = { modeStack: [
        { mode: row.mode, rawMode: row.rawMode }, { mode: row.mode, rawMode: row.rawMode },
      ], index: 1, blockSpecial: false, blockTopBottom: false, preventShade: false, color: row.color };
      Object.defineProperty(entry, 'blockColor', { configurable: true, enumerable: true,
        get() { throw new Error('unreviewed getter must not run'); } });
      store.dmMap.set(row.dmid, entry);
    }
  });
  await page.evaluate(() => window.__BILI_FIXTURE__.play());
  const beforeNoSelection = await media();
  const noSelection = await waitStatus(value => value.state === 'running' &&
    value.reason === 'no-selected-candidates' && value.ownedRelease?.known &&
    value.ownedRelease?.totals?.selected === 0 &&
    value.ownedRelease?.rejected?.['mode-stack-state-unavailable'] > 0, 'zero selection reason');
  await page.waitForFunction(() => document.querySelector('#danlingo-progress')?.shadowRoot
    ?.querySelector('#native-supply-host')?.textContent?.includes('尚无入选；累计未入选：模式历史无法确认'));
  report.noSelection = { status: noSelection, ui: await ui() };
  assert.match(report.noSelection.ui.label, /尚无入选；累计未入选：模式历史无法确认/);
  assert.equal(noSelection.submittedInputs, 0);
  await screenshot('planned-zero-selection');
  noPlaybackWrites(beforeNoSelection, await media(), 'zero selection');
  await page.evaluate(() => {
    const store = window.player.rootStore.blockStore;
    for (const row of store.dmMap.values()) Object.defineProperty(row, 'blockColor', {
      configurable: true, enumerable: true, writable: true, value: true });
    // This changes the rule fingerprint and replans the current five seconds.
    // Keep both the relevant color change and an irrelevant special change.
    window.player.rootStore.dmSettingStore.state.typeSpecial = false;
  });
  await waitStatus(value => value.mode === 'planned' && value.state === 'running' && !value.reason && value.report?.planned === true &&
    value.ownedRelease?.known === true && value.submittedInputs > 0, 'enabled planner and attempted local work');
  report.checks.push('zero-selection-reports-native-rejection-without-playback-writes',
    'readable-color-history-change-allows-planning-and-ordinary-translation-subscription');
  await page.waitForFunction(() => document.querySelector('#danlingo-progress')?.shadowRoot
    ?.querySelector('#native-supply-host')?.textContent?.includes('缺译跳过，视频播放不受影响'));
  report.initialUi = await ui();
  assert.equal(report.initialUi.visibleSupplyButtons.length, 0);
  assert.doesNotMatch(report.initialUi.label, /启动\s*[/／]|结束实验|新预算|重置预算/);
  assert.match(report.initialUi.title, /提前5秒规划/);
  assert.equal(report.initialUi.state, '运行中');
  assert.equal(report.initialUi.plannedMetricsVisible, true);
  // The owned native list and scheduler mirror have different denominators.
  // This fixture can select native entries before the mirror receives candidates.
  const coverage = await page.locator('#danlingo-progress').locator('#coverage').textContent();
  assert.equal(report.initialUi.metrics.candidates, coverage.match(/已加载候选\s*([\d,]+)/)?.[1]);
  assert.ok(Number(report.initialUi.metrics.selected) > 0);
  assert.ok(Number(report.initialUi.metrics.submitted) > 0);
  assert.equal(report.initialUi.diagnosticsHidden, true);
  await screenshot('planned-enabled');
  const beforeMissing = await media();
  await fetch(2.1);
  const afterMissing = await media();
  noPlaybackWrites(beforeMissing, afterMissing, 'missing translation');
  assert.equal(afterMissing.main.renders.length, 0, 'ordinary source without translation must skip');
  report.missing = { report: (await pageStatus()).report, renders: afterMissing.main.renders };
  report.checks.push('ordinary-enabled-planner-without-start-or-budget-controls',
    'missing-translation-skips-without-playback-or-clear-writes');

  assert.equal((await save({ displayMode: 'original' })).ok, true);
  await waitStatus(value => value.mode === 'planned' && value.state === 'disabled', 'original mode');
  report.originalUi = await ui();
  assert.match(report.originalUi.label, /原文显示中/);
  await screenshot('planned-original');
  const beforeOriginal = await media();
  await fetch(5.1);
  const afterOriginal = await media();
  noPlaybackWrites(beforeOriginal, afterOriginal, 'original mode');
  assert.ok(afterOriginal.main.renders.some(row => row.text === '顶部弹幕'));
  report.checks.push('ordinary-original-mode-restores-native-rendering');

  assert.equal((await save({ enabled: false, displayMode: 'translated' })).ok, true);
  await waitStatus(value => value.mode === 'planned' && value.state === 'disabled', 'disabled setting');
  report.disabledUi = await ui();
  assert.match(report.disabledUi.reason, /请开启/);
  assert.equal(report.disabledUi.progressVisible, false);
  assert.equal(report.disabledUi.disabledNoticeVisible, true);
  const beforeDisabled = await media();
  await fetch(8.1);
  const afterDisabled = await media();
  noPlaybackWrites(beforeDisabled, afterDisabled, 'disabled setting');
  assert.ok(afterDisabled.main.renders.some(row => row.text === '底部弹幕'));
  report.checks.push('ordinary-disabled-setting-restores-native-rendering');

  assert.equal((await save({ enabled: true })).ok, true);
  const reenabled = await waitStatus(value => value.mode === 'planned' && value.report?.planned === true,
    'reenabled planner');
  const beforeFailure = await media();
  await fetch(11.1);
  await waitStatus(value => value.mode === 'planned' && value.submittedInputs > 0 &&
    (value.report?.counts?.ownedSuppressed ?? 0) > (reenabled.report?.counts?.ownedSuppressed ?? 0),
  'failed local input and native skip');
  const afterFailure = await media();
  noPlaybackWrites(beforeFailure, afterFailure, 'unregistered local model failure');
  assert.equal(afterFailure.main.renders.some(row => row.text === '逆向弹幕'), false);
  report.failure = { status: await pageStatus(), rendered: afterFailure.main.renders.length };
  report.checks.push('unregistered-local-model-failure-skips-without-playback-writes');

  const beforeCleanup = await media();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.waitForFunction(() => window.__BILI_FIXTURE__.nativeEvidence().insertWrapped === false);
  const afterCleanup = await media();
  noPlaybackWrites(beforeCleanup, afterCleanup, 'pagehide cleanup');
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await waitStatus(value => value.report?.planned && value.ownedRelease?.known, 'pageshow reconnect');
  await page.waitForFunction(() => window.__BILI_FIXTURE__.nativeEvidence().initWrapped === true);
  noPlaybackWrites(afterCleanup, await media(), 'pageshow reconnect');
  report.rebindings = [];
  for (const [part, cid] of [[2, '62132'], [1, '62131']]) {
    const previousSession = await page.evaluate(() => window.__PLANNED_SNAPSHOTS__.at(-1)?.session);
    await page.evaluate(({ part, cid }) => {
      window.__BILI_FIXTURE__.switchPage(part, cid);
      window.__INSTALL_PLANNED_CONTRACT__();
    }, { part, cid });
    const beforeBinding = await media();
    const status = await waitStatus(value => value.mode === 'planned' && value.state === 'running' &&
      value.ownedRelease?.resourceId === `av2:cid${cid}` && value.ownedRelease?.known,
    `switch to cid ${cid}`);
    await page.waitForFunction(({ cid, previousSession }) => {
      const snapshot = window.__PLANNED_SNAPSHOTS__.at(-1);
      return snapshot?.resourceId === `av2:cid${cid}` && snapshot.session !== previousSession;
    }, { cid, previousSession });
    const restored = await page.evaluate(() => window.__BILI_FIXTURE__.restorations());
    assert.ok(restored.every(row => row.hookRestored && row.insertRestored && row.initRestored));
    noPlaybackWrites(beforeBinding, await media(), `rebind cid ${cid}`);
    report.rebindings.push({ cid, resourceId: status.ownedRelease.resourceId,
      session: await page.evaluate(() => window.__PLANNED_SNAPSHOTS__.at(-1)?.session), restored });
  }
  report.checks.push('pageshow-reconnects-without-playback-writes', 'video-A-B-A-rebinds-and-restores-old-hooks');

  // Prepared-wire injection checks the built adapter independently of model
  // transport. Full ordinary transport uses the separate in-memory chain test.
  const displayBase = await page.evaluate(() => {
    const f = window.__BILI_FIXTURE__, manager = window.player.danmaku.getDanmakuX().manager;
    f.pause();
    const row = { dmid: '987654321', id_str: '987654321', text: '译文显示测试', stime: f.state.time + 3.5,
      mode: 1, rawMode: 1, pool: 0, uhash: 'prepared-fixture-author', size: 25,
      color: 16777215, weight: 20, border: false, colorful: false };
    manager.dataBase.dmArray.push(row);
    manager.dataBase.timeLine.list.push(structuredClone(row));
    manager.config.setting.limit += 1; // New rule generation for already sealed fixture buckets.
    f.play();
    return f.state.time;
  });
  await page.waitForFunction(() => window.__PLANNED_LISTS__.at(-1)?.items.some(row => row.sourceId === '987654321'));
  await page.evaluate(() => window.__BILI_FIXTURE__.pause());
  await waitStatus(value => value.reason === 'playback-suspended', 'hold fixture before prepared delivery');
  await page.waitForFunction(() => window.__PLANNED_SOURCE_PACKETS__.some(packet =>
    packet.upserts?.some(row => row.sourceId === '987654321') && window.__PLANNED_SOURCE_ACKS__.some(ack =>
      ack.session === packet.session && ack.sourceGeneration === packet.sourceGeneration &&
      ack.revision === packet.revision && ack.index === packet.index)));
  const injected = await page.evaluate(() => {
    const list = window.__PLANNED_LISTS__.at(-1), control = window.__PLANNED_CONTROL__;
    const row = list.items.find(row => row.sourceId === '987654321');
    window.postMessage({ bridge: 'danlingo.native.v1', from: 'content', type: 'prepared',
      session: list.session, resourceId: list.resourceId, urlResourceId: list.urlResourceId,
      generation: control.generation, plannedSupply: true,
      items: [{ ...row, text: '字幕が表示されます', status: 'translated', epoch: list.epoch,
        predictionEpoch: list.predictionEpoch, ruleRevision: list.ruleRevision,
        configIdentity: control.plannedSupply.configIdentity }] }, location.origin);
    return { epoch: list.epoch, predictionEpoch: list.predictionEpoch, sourceId: row.sourceId };
  });
  await waitStatus(value => value.report?.ready > 0, 'prepared injection accepted');
  const paused = await waitStatus(value => value.reason === 'playback-suspended', 'pause retains prepared text');
  await page.waitForFunction(() => document.querySelector('#danlingo-progress')?.shadowRoot
    ?.querySelector('#native-supply-host')?.textContent?.includes('等待播放，保留已准备译文'));
  await screenshot('planned-paused-retained');
  // Pass the original three-second adoption estimate while the media clock is held.
  await page.waitForTimeout(4000);
  const held = await pageStatus();
  assert.equal(held.ownedRelease.predictionEpoch, injected.predictionEpoch);
  assert.equal(held.report.ready, paused.report.ready);
  assert.equal(held.submittedInputs, paused.submittedInputs);
  await page.evaluate(() => window.__BILI_FIXTURE__.play());
  await waitStatus(value => value.state === 'running', 'resume preserved list');
  const beforeAdopt = await media();
  for (let step = 1; step <= 4; step++) {
    await page.evaluate(value => { window.__BILI_FIXTURE__.state.time = value; }, displayBase + step * .75);
    if (step < 4) await page.waitForTimeout(200);
  }
  await page.evaluate(value => window.player.danmaku.getDanmakuX().manager.fetchAndInitDm(value), displayBase + 3);
  const visible = page.locator('#danmaku-stage [data-dmid="987654321"]');
  await visible.waitFor({ state: 'visible' });
  assert.equal(await visible.textContent(), '字幕が表示されます');
  const nativeText = await page.evaluate(() => {
    const manager = window.player.danmaku.getDanmakuX().manager;
    const original = manager.dataBase.timeLine.list.find(row => row.dmid === '987654321');
    const model = manager.visualArray.find(row => row.textData.dmid === '987654321');
    const node = document.querySelector('#danmaku-stage [data-dmid="987654321"]');
    const rect = node.getBoundingClientRect(), container = manager.container.getBoundingClientRect();
    return { original: original.text, author: original.uhash, modelText: model.textData.text,
      modelAuthor: model.textData.uhash, on: original.on,
      intersects: rect.width > 0 && rect.height > 0 && rect.left < container.right && rect.right > container.left &&
        rect.top < container.bottom && rect.bottom > container.top };
  });
  assert.equal(nativeText.original, '译文显示测试');
  assert.equal(nativeText.modelAuthor, nativeText.author);
  assert.equal(nativeText.on, true);
  assert.equal(nativeText.intersects, true);
  const adopted = await waitStatus(value => (value.report?.counts?.adopted ?? 0) > 0, 'native adopted text');
  await page.waitForFunction(() => document.querySelector('#danlingo-progress')?.shadowRoot
    ?.querySelector('#supply-adopted')?.textContent?.trim() === '1');
  noPlaybackWrites(beforeAdopt, await media(), 'prepared native adoption');
  const visiblePath = resolve(directory, 'planned-prepared-visible.png');
  await page.screenshot({ path: visiblePath }); report.screenshots.push(visiblePath);
  report.preparedDisplay = { evidence: 'PREPARED_WIRE_INJECTION_SYNTHETIC_NATIVE_DOM', injected,
    paused: { inputs: paused.submittedInputs, ready: paused.report.ready },
    held: { inputs: held.submittedInputs, ready: held.report.ready }, nativeText,
    counts: adopted.report.counts, firstShowMeasured: false };
  report.checks.push('fresh-worker-row-without-on-adopts-prepared-text-into-visible-dom',
    'pause-past-original-deadline-retains-prepared-list-without-new-inputs');
  const beforeContractFault = await media();
  await page.evaluate(() => { window.player.danmaku.getDanmakuX().manager.config.setting.fontSize = 0; });
  await waitStatus(value => value.state === 'unavailable' && /native-contract-unavailable/.test(value.reason),
    'unavailable native contract is shown');
  await page.waitForFunction(() => document.querySelector('#danlingo-progress')?.shadowRoot
    ?.querySelector('#native-supply-host')?.textContent?.includes('native-contract-unavailable'));
  report.contractFaultUi = await ui();
  assert.match(report.contractFaultUi.label, /native-contract-unavailable/);
  assert.doesNotMatch(report.contractFaultUi.label, /缺译跳过，视频播放不受影响/);
  await screenshot('planned-unavailable');
  noPlaybackWrites(beforeContractFault, await media(), 'unavailable native contract');
  await page.evaluate(() => { window.player.danmaku.getDanmakuX().manager.config.setting.fontSize = 1; });
  await waitStatus(value => value.state === 'running' && value.ownedRelease?.known, 'native contract recovery');
  noPlaybackWrites(beforeContractFault, await media(), 'native contract recovery');
  report.checks.push('native-contract-failure-and-recovery-show-actual-state-without-playback-writes');
  // Inspect hybrid statistics with both transports unavailable. No key/model is
  // registered; only this isolated profile receives the synthetic configuration.
  const hybridDraft = await settingsPage.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'local-control', control: { action: 'unload' } });
    const { settings } = await chrome.runtime.sendMessage({ type: 'settings' });
    const draft = { ...settings, localPreloadOnEntry: false };
    const capacity = await chrome.runtime.sendMessage({ type: 'hybrid-capacity', settings: draft });
    if (!capacity.ok || !capacity.identity) throw new Error('fixture capacity identity missing');
    return { ...draft, bilibiliHybrid: { enabled: true, profiles: [
      { identity: capacity.identity, maxItems: 2, maxChars: 200, manual: true },
    ] } };
  });
  await worker.evaluate(settings => chrome.storage.local.set({ 'settings.v1': settings }), hybridDraft);
  await page.reload();
  await page.waitForFunction(() => {
    const details = document.querySelector('#danlingo-progress')?.shadowRoot?.querySelector('#hybrid-details');
    return details && !details.hidden && details.querySelector('summary')?.textContent?.includes('混合后台统计');
  });
  report.hybridStatistics = { evidence: 'BUILT_UI_ZERO_TRANSPORT_STATISTICS', status: await pageStatus(), ui: await ui() };
  assert.equal(report.hybridStatistics.status.hybridStatsScope, 'background-worker-all-tabs');
  assert.match(report.hybridStatistics.ui.title, /当前页面/);
  assert.equal(report.hybridStatistics.ui.hybrid.visible, true);
  assert.equal(report.hybridStatistics.ui.hybrid.summary, '混合后台统计');
  assert.equal(report.hybridStatistics.ui.hybrid.scope, '本次运行 · 所有标签页');
  assert.equal(report.hybridStatistics.ui.metrics.localRequests, '0');
  assert.equal(report.hybridStatistics.ui.metrics.onlineRequests, '0');
  assert.equal(report.hybridStatistics.ui.diagnosticsHidden, true);
  await page.locator('#danlingo-progress').locator('#hybrid-details > summary').click();
  await screenshot('hybrid-statistics-expanded');
  await page.setViewportSize({ width: 390, height: 780 });
  await screenshot('hybrid-statistics-narrow');
  const labelFits = await page.locator('#danlingo-progress').evaluate(host => {
    const label = host.shadowRoot.querySelector('#native-supply-host');
    return label.scrollWidth <= label.clientWidth + 1;
  });
  assert.ok(labelFits, 'hybrid statistics should wrap within the narrow panel');
  report.checks.push('hybrid-statistics-label-page-and-all-tab-scopes-with-zero-transport',
    'hybrid-statistics-wrap-in-narrow-panel');
  report.localAfter = (await localState()).state;
  assert.equal(report.localBefore?.phase, 'idle');
  assert.equal(report.localAfter?.phase, 'idle');
  assert.equal(report.localAfter?.inferenceCalls ?? 0, 0);
  report.ownedRecords = await worker.evaluate(() => chrome.storage.local.get([
    'bilibiliOwnedSupply.grant.v1', 'bilibiliOwnedSupply.budget.v1', 'bilibiliOwnedSupply.zeroTransport.v1',
  ]));
  assert.deepEqual(report.ownedRecords, {});
  assert.deepEqual(report.errors, []);
  report.checks.push('pagehide-cleanup-without-playback-writes',
    'local-preload-off-never-loads-model', 'all-nonfixture-http-blocked');
  report.passed = true;
} finally {
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  await context.close();
  console.log(JSON.stringify({ directory, version: identity.version, passed: report.passed,
    checks: report.checks, blockedHttp: report.blockedHttp.length, errors: report.errors }));
}
