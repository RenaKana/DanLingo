import test from 'node:test';
import assert from 'node:assert/strict';
import { BilibiliOwnedRelease } from '../../src/platforms/bilibili/owned-release.ts';
import { attachBilibiliNative, resolveBilibiliBinding } from '../../src/platforms/bilibili/video.ts';
import { createBilibiliShadowRules } from '../../src/platforms/bilibili/shadow-rules.ts';
import { USER_FILTER_NATIVE_CALLBACK, USER_FILTER_NATIVE_FUNCTIONS } from '../../src/platforms/bilibili/user-filter-contract.ts';

const resourceId = 'av2:cid62131';
const href = 'https://www.bilibili.com/video/BV1xx411c7mD/?p=1';
const control = { enabled: true, policy: 'owned', runId: 'owned-1', instanceId: 'instance-1',
  configIdentity: 'config-1', sourceLanguage: 'auto', targetLanguage: 'ja',
  fromMs: 0, toMs: 45000, state: 'running' };
const plannedSupply = { enabled: true, configIdentity: 'config-1',
  sourceLanguage: 'auto', targetLanguage: 'ja' };
const idOf = value => JSON.stringify(['bilibili', resourceId, String(value)]);
const item = (id, stime, text = `中文${id}`, extra = {}) => ({
  dmid: String(id), text, stime, mode: 1, rawMode: 1, pool: 0, on: false,
  uhash: `author-${id}`, size: 25, color: 16777215, weight: 20, ...extra,
});
const nativeFunction = source => new Function(`return (${source})`)();
const nativeBlockMap = {
  blockScroll: [1], blockTopBottom: [5, 4],
  blockColor: [2012, 2015, 2007, 2008, 2009, 2013, 2002, 2003, 2000, 2001, 2004, 5, 4, 1, 6],
  blockSpecial: [2005, 2012, 2015, 2002, 2003, 2000, 2001, 2004, 2006, 2013, 2008, 2009, 2011, 2007, 2014, 2010, 3000, 2016, 2017, 2018, 2020],
  preventShade: [4],
};

function fixture(list = [item(1, 4.5)], pool = list, { realRules = false, beforeRender, nativeFilter } = {}) {
  let mono = 100, wall = 1000, clearCalls = 0, pauseCalls = 0, playCalls = 0, fetchCalls = 0;
  let currentTime = 0, playbackRate = 1, timeWrites = 0, rateWrites = 0;
  const messages = [], hooks = [], filtered = [], models = [];
  const listeners = new Map();
  const setting = { visible: true, area: 100, fontSize: 1, limit: 300, preTime: 1,
    noDanmakuXTypes: [] };
  const video = { get currentTime() { return currentTime; }, set currentTime(value) { timeWrites++; currentTime = value; },
    duration: 120, get playbackRate() { return playbackRate; }, set playbackRate(value) { rateWrites++; playbackRate = value; }, paused: false,
    seeking: false, readyState: 4, ended: false, isConnected: true,
    played: { length: 1 }, buffered: { length: 0 },
    pause() { pauseCalls++; this.paused = true; },
    play() { playCalls++; this.paused = false; return Promise.resolve(); },
    addEventListener(type, callback) { const set = listeners.get(type) ?? new Set(); set.add(callback); listeners.set(type, set); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); } };
  let nativeCandidates = [list[0]];
  let reject = false;
  const manager = { config: { setting }, containerSize: { width: 500, height: 280 },
    container: { ownerDocument: { hidden: false } },
    dataBase: { dmArray: pool, timeLine: { list } },
    lastTime: 0, cDmlist: [], visualArray: [],
    validate() { return !reject; },
    fetchAndInitDm(render) {
      fetchCalls++;
      this.lastTime = render + setting.preTime;
      this.insert(nativeCandidates);
      danmaku.timeController.lastFetchDmTime = render;
      return 'fetched';
    },
    insert(entries) {
      danmaku.hooks.beforeRender([], entries.slice());
      for (const source of entries) {
        filtered.push({ item: source, text: source.text, author: source.uhash });
        if (nativeFilter?.(source, blockStore) === false || !this.validate(source) || source.on) continue;
        source.on = true;
        this.initRender(source);
      }
    },
    initRender(source) {
      const model = { textData: source, text: source.text, size: source.size,
        firstShow() { return 'shown'; } };
      models.push(model); this.cDmlist.push(model); return model;
    },
  };
  const danmaku = { manager, config: { setting }, timeController: { renderTime: 0, lastFetchDmTime: 0 },
    isRunning: true, hooks: { beforeRender(_active, entries) {
      hooks.push(entries.map(x => x)); beforeRender?.(entries, blockStore);
    } },
    getMetadata: () => ({ version: '1.1.24', lastCompiled: '2026-09-10T15:18:49+08:00' }),
    clear() { clearCalls++; manager.cDmlist.length = 0; manager.visualArray.length = 0; } };
  const player = { getManifest: () => ({ aid: '2', cid: '62131', bvid: 'BV1xx411c7mD', p: 1 }),
    danmaku: { getDanmakuX: () => danmaku }, mediaElement: () => video };
  let blockStore;
  if (realRules) {
    const dmSettingStore = { state: { status: true, dmarea: 50, dmdensity: 1,
      typeScroll: true, typeTopBottom: true, typeColor: true, typeSpecial: true,
      seniorMode: false, preventshade: false } };
    blockStore = { blockList: [], reportFilter: [], dmMap: new Map(),
      DmBlockMap: nativeBlockMap, dmSettingStore,
      aiJudge: nativeFunction('function(n,r){return this.totalFiltleredDm+=1,Math.abs(n.weight)<r&&(this.aiCloudBlockCount+=1,!0)}'),
      reportFilterReg: nativeFunction('function(n){var r;return null!=(r=this.reportFilter)&&!!r.length&&this.reportFilter.some(function(r){if(new RegExp(r).test(n.text))return!0})}'),
    };
    for (const [name, source] of Object.entries(USER_FILTER_NATIVE_FUNCTIONS))
      blockStore[name] = nativeFunction(source);
    manager.config.scene = { isMini: false };
    manager.config.fn = { filter: nativeFunction(USER_FILTER_NATIVE_CALLBACK) };
    player.rootStore = { rootPlayer: player, danmakuStore: { danmakuX: danmaku },
      blockStore, dmSettingStore };
  }
  const binding = resolveBilibiliBinding(player, href);
  assert.ok(binding);
  let ruleRevision = 4, fingerprint = 'rule-4', ruleKnown = true;
  let match = () => ({ state: 'retain', reason: 'allowed' });
  const stubRules = { read: () => ({ known: ruleKnown, revision: ruleRevision, fingerprint,
    reason: ruleKnown ? null : 'rules-unavailable', nativeSettings: { visible: setting.visible }, match }) };
  const rules = realRules ? createBilibiliShadowRules({ player, danmaku,
    documentScope: 'owned-native-contract', now: () => mono, allowPartialUserRules: () => true }) : stubRules;
  const owned = (updates, onMiss) => new BilibiliOwnedRelease({ binding, session: 'owned-session',
    now: () => mono, epochNow: () => wall, rules, onUpdate: update => updates.push(update), onMiss });
  const attachment = attachBilibiliNative(binding, { now: () => mono, epochNow: () => wall,
    post: message => messages.push(message), shadowRules: rules });
  const content = payload => attachment.onMessage({ data: { bridge: 'danlingo.native.v1',
    from: 'content', session: attachment.session, resourceId,
    urlResourceId: attachment.identity.urlResourceId, ...payload } });
  const start = () => {
    content({ type: 'control', generation: 0, enabled: true, displayMode: 'translated',
      bilibiliOwnedRelease: true, bilibiliShadowScheduler: false, nativeSupply: control });
    attachment.tick();
  };
  const startPlanned = (supply = plannedSupply) => {
    content({ type: 'control', generation: 0, enabled: true, displayMode: 'translated',
      bilibiliOwnedRelease: true, bilibiliShadowScheduler: false, plannedSupply: supply });
    attachment.tick();
  };
  const shadow = () => messages.filter(x => x.type === 'bilibili-shadow' && x.policy === 'owned').at(-1);
  const ready = (source = list[0], overrides = {}) => {
    const update = shadow(); assert.equal(update?.known, true);
    assert.ok(update.items.some(x => x.id === idOf(source.dmid)));
    const selected = update.items.find(x => x.id === idOf(source.dmid));
    content({ type: 'prepared', generation: 0, nativeSupply: true, items: [{
      id: selected.id, sourceId: source.dmid, originalText: source.text, text: `訳${source.dmid}`,
      status: 'translated', epoch: attachment.epoch, predictionEpoch: update.predictionEpoch,
      ruleRevision: update.ruleRevision, deadlineAtEpochMs: selected.deadlineAtEpochMs,
      runId: control.runId, instanceId: control.instanceId, configIdentity: control.configIdentity,
      ...overrides,
    }] });
  };
  const readyPlanned = (source = list[0], overrides = {}) => {
    const update = shadow(); assert.equal(update?.known, true);
    const selected = update.items.find(x => x.id === idOf(source.dmid));
    assert.ok(selected);
    content({ type: 'prepared', generation: 0, plannedSupply: true, items: [{
      id: selected.id, sourceId: source.dmid, originalText: source.text, text: `訳${source.dmid}`,
      status: 'translated', epoch: attachment.epoch, predictionEpoch: update.predictionEpoch,
      ruleRevision: update.ruleRevision, deadlineAtEpochMs: selected.deadlineAtEpochMs,
      configIdentity: plannedSupply.configIdentity, ...overrides,
    }] });
  };
  return { list, setting, video, manager, danmaku, attachment, messages, hooks, filtered, models,
    blockStore, rules,
    content, start, startPlanned, shadow, ready, readyPlanned, owned,
    setTime(current, nextWall) { mono += (current - video.currentTime) * 1000 / video.playbackRate; video.currentTime = current; wall = nextWall; },
    advanceWall(ms) { mono += ms; wall += ms; },
    dispatch(type) { for (const callback of listeners.get(type) ?? []) callback(); },
    setNativeCandidates(value) { nativeCandidates = value; },
    setReject(value) { reject = value; },
    setRule(next, revision = 5) { match = next; ruleRevision = revision; fingerprint = `rule-${revision}`; },
    setRuleKnown(value) { ruleKnown = value; },
    seek(value) { video.currentTime = value; for (const callback of listeners.get('seeking') ?? []) callback(); },
    resetPlaybackWrites() { timeWrites = 0; rateWrites = 0; },
    get playbackWrites() { return { pauseCalls, playCalls, timeWrites, rateWrites }; },
    get clearCalls() { return clearCalls; }, get pauseCalls() { return pauseCalls; },
    get fetchCalls() { return fetchCalls; } };
}

test('pause and buffering hold the list and prepared text through repeated long waits', t => {
  const f = fixture(); t.after(() => f.attachment.stop());
  f.startPlanned(); f.readyPlanned();
  const before = f.shadow();
  f.resetPlaybackWrites();
  for (const paused of [true, false, true]) {
    f.video.paused = paused; f.video.readyState = paused ? 4 : 2;
    f.danmaku.isRunning = false;
    f.dispatch(paused ? 'pause' : 'waiting');
    for (let i = 0; i < 10; i++) {
      f.advanceWall(3000);
      // The normal content heartbeat, without enabling or changing settings.
      f.content({ type: 'control', generation: 0, enabled: true, displayMode: 'translated',
        bilibiliOwnedRelease: true, plannedSupply });
      f.attachment.tick();
      assert.equal(f.shadow().predictionEpoch, before.predictionEpoch);
      assert.equal(f.shadow().suspended, true);
      assert.equal(f.shadow().known, true);
      assert.equal(f.attachment.nativeSupply.report().ready, 1);
    }
  }
  assert.equal(f.shadow().items[0].deadlineAtEpochMs, f.shadow().sampledAtEpochMs + 60_000);
  assert.equal(f.messages.findLast(row => row.type === 'snapshot').nativeSupply.ownedRelease.totals.selected, 1);
  f.video.paused = false; f.video.readyState = 4; f.danmaku.isRunning = true;
  // This gap is not a seek. Resume must not extrapolate wall time spent paused.
  f.advanceWall(2000); f.dispatch('playing');
  assert.equal(f.attachment.epoch, 0);
  assert.equal(f.shadow().predictionEpoch, before.predictionEpoch);
  assert.equal(f.shadow().items[0].deadlineAtEpochMs, before.items[0].deadlineAtEpochMs + 92_000);
  f.setTime(4, 97_000);
  f.content({ type: 'control', generation: 0, enabled: true, displayMode: 'translated',
    bilibiliOwnedRelease: true, plannedSupply });
  f.resetPlaybackWrites(); f.manager.fetchAndInitDm(4);
  assert.equal(f.models.length, 1);
  assert.equal(f.models[0].text, '訳1');
  assert.equal(f.attachment.nativeSupply.report().counts.adopted, 1);
  assert.deepEqual(f.playbackWrites, { pauseCalls: 0, playCalls: 0, timeWrites: 0, rateWrites: 0 });
});

test('cold pause seals only the frozen five-second window with native filters and bounded preparation leases', t => {
  const timeline = [item(1, .5), item(2, 4.5), item(3, 4.6), item(4, 4.7), item(5, 5.5)];
  const f = fixture(timeline); const updates = [], owned = f.owned(updates);
  t.after(() => owned.stop());
  f.setRule(source => source.dmid === '4'
    ? { state: 'exclude', reason: 'native-user-keyword' }
    : { state: 'retain', reason: 'allowed' });
  f.manager.containerSize.height = 28.125;
  f.video.paused = true; f.danmaku.isRunning = false;
  owned.tick(0);
  const first = updates.at(-1);
  assert.equal(first.known, true);
  assert.equal(first.suspended, true);
  assert.deepEqual(first.items.map(row => row.sourceId), ['1', '2']);
  assert.deepEqual(first.items.map(row => row.deadlineAtEpochMs), [61_000, 61_000]);
  assert.equal(owned.report().rejected['native-user-keyword'], 1);
  assert.equal(owned.report().rejected['density-cap'], 1);
  f.advanceWall(90_000); owned.tick(0);
  assert.equal(updates.at(-1).predictionEpoch, first.predictionEpoch);
  assert.deepEqual(updates.at(-1).items.map(row => row.sourceId), ['1', '2']);
  assert.deepEqual(updates.at(-1).items.map(row => row.deadlineAtEpochMs), [151_000, 151_000]);
  assert.equal(owned.report().totals.selected, 2);
  assert.equal(owned.report().sealedBuckets, 5);
  f.video.paused = false; f.danmaku.isRunning = true; owned.tick(0);
  assert.deepEqual(updates.at(-1).items.map(row => [row.sourceId, row.deadlineAtEpochMs]), [['2', 94_500]],
    'resuming restores the playback deadline and cancels near work whose opportunity already passed');
  assert.deepEqual(f.playbackWrites, { pauseCalls: 0, playCalls: 0, timeWrites: 0, rateWrites: 0 });
});

test('pause lease never revives preexpired or terminal rows, and restores live playback deadlines', t => {
  const timeline = [item(1, 1), item(2, 2), item(3, 4.5), item(4, 4.6), item(5, 4.7)];
  const f = fixture(timeline); const updates = [], owned = f.owned(updates);
  t.after(() => owned.stop());
  owned.tick(0);
  owned.markSupplied(timeline[3]); owned.markSuppressed(timeline[4]);
  f.advanceWall(1500);
  f.video.paused = true; f.danmaku.isRunning = false; owned.tick(0);
  assert.deepEqual(updates.at(-1).items.map(row => row.sourceId), ['3']);
  assert.equal(updates.at(-1).items[0].deadlineAtEpochMs, 62_500);
  f.advanceWall(5000); owned.tick(0);
  assert.deepEqual(updates.at(-1).items.map(row => row.sourceId), ['3']);
  assert.equal(updates.at(-1).items[0].deadlineAtEpochMs, 67_500);
  f.video.paused = false; f.danmaku.isRunning = true; owned.tick(0);
  assert.deepEqual(updates.at(-1).items.map(row => [row.sourceId, row.deadlineAtEpochMs]), [['3', 9500]]);
  assert.deepEqual(f.playbackWrites, { pauseCalls: 0, playCalls: 0, timeWrites: 0, rateWrites: 0 });
});

test('paused selections keep validating source text and pool identity', t => {
  const timeline = [item(1, 4.5), item(2, 4.6)];
  const pool = structuredClone(timeline);
  const f = fixture(timeline, pool); const updates = [], misses = [];
  const owned = f.owned(updates, (...args) => misses.push(args));
  t.after(() => owned.stop());
  f.video.readyState = 2; f.danmaku.isRunning = false;
  owned.tick(0);
  assert.deepEqual(updates.at(-1).items.map(row => row.sourceId), ['1', '2']);
  timeline[0].text = 'changed source'; pool[1].uhash = 'changed author';
  owned.tick(0);
  assert.deepEqual(updates.at(-1).items, []);
  assert.deepEqual(misses.map(([, , , , reason]) => reason),
    ['source-metadata-changed', 'source-membership-changed']);
  f.advanceWall(5000); owned.tick(0);
  assert.deepEqual(updates.at(-1).items, []);
  assert.equal(misses.length, 2);
  assert.deepEqual(f.playbackWrites, { pauseCalls: 0, playCalls: 0, timeWrites: 0, rateWrites: 0 });
});

test('window-fullscreen-window resizing preserves sealed plans and both early and later prepared text', t => {
  const timeline = [item(1, 4.5), item(2, 4.6)];
  const f = fixture(timeline, structuredClone(timeline)); t.after(() => f.attachment.stop());
  f.startPlanned(); f.readyPlanned(timeline[0]);
  const before = f.shadow();
  const selected = before.items.map(row => ({ id: row.id, deadlineAtEpochMs: row.deadlineAtEpochMs }));
  f.resetPlaybackWrites();
  for (const size of [{ width: 1920, height: 1080 }, { width: 500, height: 280 },
    { width: 1280, height: 720 }, { width: 500, height: 280 }]) {
    Object.assign(f.manager.containerSize, size);
    f.attachment.tick();
    assert.equal(f.shadow().known, true);
    assert.equal(f.shadow().predictionEpoch, before.predictionEpoch);
    assert.deepEqual(f.shadow().items.map(row => ({ id: row.id, deadlineAtEpochMs: row.deadlineAtEpochMs })), selected);
    assert.equal(f.attachment.nativeSupply.report().ready, 1);
    assert.equal(f.messages.findLast(row => row.type === 'snapshot').nativeSupply.ownedRelease.totals.selected, 2);
  }
  f.readyPlanned(timeline[1]);
  assert.equal(f.attachment.nativeSupply.report().ready, 2, 'a prepared result arriving after resize remains qualified');
  f.setNativeCandidates(timeline);
  f.setTime(4, 2000); f.resetPlaybackWrites(); f.manager.fetchAndInitDm(4);
  assert.deepEqual(f.models.map(model => model.text), ['訳1', '訳2']);
  assert.equal(f.attachment.nativeSupply.report().counts.adopted, 2);
  for (const model of f.models) model.textData.on = false;
  Object.assign(f.manager.containerSize, { width: 1920, height: 1080 });
  f.attachment.tick(); f.manager.fetchAndInitDm(4);
  assert.equal(f.models.length, 2, 'resizing after native consumption cannot replay either event');
  assert.equal(f.attachment.nativeSupply.report().counts.adopted, 2);
  assert.deepEqual(f.playbackWrites, { pauseCalls: 0, playCalls: 0, timeWrites: 0, rateWrites: 0 });
});

test('a resized container limits newly opened buckets without reopening terminal selections', t => {
  const timeline = [item(1, 4.5), item(2, 4.6), item(3, 5.2), item(4, 5.3)];
  const f = fixture(timeline); t.after(() => f.attachment.stop());
  const updates = [], owned = f.owned(updates);
  owned.tick(0);
  const before = updates.at(-1);
  assert.deepEqual(before.items.map(row => row.sourceId), ['1', '2']);
  f.manager.containerSize.height = 28.125;
  f.setTime(1, 2000); owned.tick(0);
  assert.equal(updates.at(-1).predictionEpoch, before.predictionEpoch);
  assert.deepEqual(updates.at(-1).items.map(row => row.sourceId), ['1', '2', '3']);
  assert.equal(updates.at(-1).items[0].deadlineAtEpochMs, before.items[0].deadlineAtEpochMs);
  assert.equal(owned.report().rejected['density-cap'], 1, 'the new bucket uses the smaller height');
  owned.markSupplied(timeline[0]); owned.markSuppressed(timeline[2]);
  f.setTime(4.7, 5700); owned.tick(0);
  assert.equal(owned.report().totals.missed, 1);
  f.manager.containerSize.height = 280; owned.tick(0);
  assert.equal(updates.at(-1).predictionEpoch, before.predictionEpoch);
  assert.deepEqual(updates.at(-1).items, []);
  assert.deepEqual(owned.report().totals, { selected: 3, supplied: 1, missed: 1, suppressed: 1 });
  assert.equal(owned.matches(timeline[3]), false, 'a rejected row in a sealed bucket stays rejected');
});

test('invalid dimensions revoke the previous prepared generation and never revive it on recovery', async t => {
  for (const [name, dimensions] of [['zero width', { width: 0 }], ['NaN width', { width: NaN }],
    ['zero height', { height: 0 }], ['NaN height', { height: NaN }]])
    await t.test(name, t => {
      const f = fixture(); t.after(() => f.attachment.stop());
      f.startPlanned(); f.readyPlanned();
      const before = f.shadow();
      Object.assign(f.manager.containerSize, dimensions); f.attachment.tick();
      assert.equal(f.shadow().known, false);
      assert.ok(f.shadow().predictionEpoch > before.predictionEpoch);
      assert.equal(f.attachment.nativeSupply.report().ready, 0);
      Object.assign(f.manager.containerSize, { width: 500, height: 280 }); f.attachment.tick();
      assert.equal(f.attachment.nativeSupply.report().ready, 0);
      f.setTime(4, 2000); f.manager.fetchAndInitDm(4);
      assert.equal(f.models.length, 0, 'an old prepared result cannot survive a lost native contract');
    });
});

test('real native rule changes and seek still revoke prepared text after a harmless resize', t => {
  const f = fixture([item(1, 4.5)], undefined, { realRules: true });
  t.after(() => f.attachment.stop());
  f.startPlanned(); f.readyPlanned();
  const before = f.shadow();
  f.manager.containerSize.height = 1080; f.attachment.tick();
  assert.equal(f.shadow().predictionEpoch, before.predictionEpoch);
  assert.equal(f.attachment.nativeSupply.report().ready, 1);
  f.blockStore.dmSettingStore.state.typeScroll = false; f.attachment.tick();
  assert.ok(f.shadow().predictionEpoch > before.predictionEpoch);
  assert.equal(f.attachment.nativeSupply.report().ready, 0);
  f.blockStore.dmSettingStore.state.typeScroll = true; f.attachment.tick();
  f.readyPlanned();
  const restored = f.shadow();
  f.seek(2); f.attachment.tick();
  assert.ok(f.attachment.epoch > restored.epoch);
  assert.equal(f.attachment.nativeSupply.report().ready, 0);
  f.setTime(4, 2000); f.manager.fetchAndInitDm(4);
  assert.equal(f.models.length, 0);
});

test('fresh parsed Worker rows without on are admitted once and acquire native lifecycle only during insert', t => {
  const row = item(1, 4.5); delete row.on;
  const f = fixture([row], structuredClone([row])); t.after(() => f.attachment.stop());
  f.startPlanned(); f.readyPlanned();
  assert.equal(Object.hasOwn(row, 'on'), false, 'preparation does not mutate the source');
  assert.equal(f.attachment.nativeSupply.report().ready, 1);
  f.setTime(4, 2000); f.manager.fetchAndInitDm(4);
  assert.equal(f.models.length, 1);
  assert.equal(f.models[0].text, '訳1');
  assert.equal(f.filtered[0].item, row);
  assert.equal(f.filtered[0].author, 'author-1');
  assert.equal(row.on, true);
  assert.equal(row.text, '中文1');
  assert.equal(Object.hasOwn(f.manager.dataBase.dmArray[0], 'on'), false);
  f.models[0].textData.on = false;
  assert.equal(row.on, false, 'native destruction proxies back to the real timeline row');
  f.manager.fetchAndInitDm(4);
  assert.equal(f.models.length, 1, 'a consumed event cannot reappear');
});

test('fresh on handling still refuses active or non-creatable native lifecycle state', async t => {
  for (const state of ['active', 'sealed', 'inherited', 'readonly']) await t.test(state, t => {
    const row = item(1, 4.5);
    const pool = structuredClone([row]);
    if (state === 'active') row.on = true;
    if (state === 'sealed') { delete row.on; Object.preventExtensions(row); }
    if (state === 'inherited') { delete row.on; Object.setPrototypeOf(row, { on: undefined }); }
    if (state === 'readonly') Object.defineProperty(row, 'on', { value: undefined, writable: false });
    const f = fixture([row], pool); t.after(() => f.attachment.stop());
    f.startPlanned(); f.readyPlanned(); f.setTime(4, 2000); f.manager.fetchAndInitDm(4);
    assert.equal(f.models.length, 0);
    assert.equal(f.filtered.length, 0);
    assert.equal(f.attachment.nativeSupply.report().events.some(event => event.type === 'ownedSuppressed' &&
      event.reason === (state === 'active' ? 'already-active' : 'native-copy-unsupported')), true);
  });
});

test('pause keeps unknown and changed-rule invalidation distinct from a valid hold', t => {
  const f = fixture(); t.after(() => f.attachment.stop());
  f.startPlanned(); f.readyPlanned();
  const before = f.shadow();
  f.video.paused = true; f.dispatch('pause');
  f.setRule(() => ({ state: 'retain', reason: 'new-rule' }), 6); f.attachment.tick();
  assert.notEqual(f.shadow().predictionEpoch, before.predictionEpoch);
  assert.equal(f.attachment.nativeSupply.report().ready, 0);
  assert.deepEqual(f.shadow().items.map(row => row.sourceId), ['1'],
    'the new rule generation may plan the same frozen window without reviving its old result');
  assert.equal(f.shadow().items[0].deadlineAtEpochMs, f.shadow().sampledAtEpochMs + 60_000);
  f.setRuleKnown(false); f.attachment.tick();
  assert.equal(f.shadow().known, false);
  assert.deepEqual(f.shadow().items, []);
});

test('real native rules admit mode-1 rows with irrelevant stack history, then adopt prepared text', t => {
  const retained = item(1, 4.5, '中文原文', { speed: 68, size: 28 });
  const blocked = item(2, 4.6, '屏蔽关键词');
  const timeline = [retained, blocked];
  const f = fixture(timeline, structuredClone(timeline), { realRules: true });
  t.after(() => f.attachment.stop());
  f.blockStore.blockList.push({ type: 0, filter: '屏蔽', opened: true });
  for (const source of timeline) f.blockStore.dmMap.set(source.dmid, {
    modeStack: [{ mode: 1, rawMode: 1 }, { mode: 1, rawMode: 1 }], index: 1,
    blockColor: false, blockSpecial: true, blockTopBottom: true, preventShade: true,
  });
  const rules = f.rules.read();
  assert.equal(rules.known, true, rules.reason ?? '');
  assert.deepEqual(rules.match(retained), { state: 'retain', reason: 'no-native-rule-matched' });
  assert.deepEqual(rules.match(blocked), { state: 'exclude', reason: 'native-user-keyword' });

  f.startPlanned();
  assert.equal(f.attachment.nativeSupply.planned, true);
  assert.equal(f.shadow().known, true);
  assert.deepEqual(f.shadow().items.map(row => row.sourceId), ['1']);
  assert.equal(f.messages.findLast(row => row.type === 'snapshot').nativeSupply.ownedRelease.totals.selected, 1);
  assert.equal(f.messages.findLast(row => row.type === 'snapshot').nativeSupply.ownedRelease.rejected['native-user-keyword'], 1);
  f.readyPlanned(retained);
  f.setNativeCandidates([blocked]);
  f.setTime(4, 2000); f.resetPlaybackWrites();
  f.manager.fetchAndInitDm(4);
  assert.deepEqual(f.filtered.map(row => [row.text, row.author]), [['中文原文', 'author-1']]);
  assert.equal(f.models[0].text, '訳1');
  assert.equal(f.models[0].textData.speed, 68);
  assert.equal(retained.text, '中文原文');
  assert.equal(f.manager.dataBase.dmArray[0].text, '中文原文');
  assert.equal(f.attachment.nativeSupply.report().counts.adopted, 1);
  assert.deepEqual(f.playbackWrites, { pauseCalls: 0, playCalls: 0, timeWrites: 0, rateWrites: 0 });
});

// The reviewed native beforeRender branches exercised below: preventShade runs
// before color, and moves the real stack index only in the formal native batch.
function prepareNativeShadeAndColor(entries, store) {
  const state = store.dmSettingStore.state;
  for (const source of entries) {
    const entry = store.dmMap.get(source.dmid);
    if (!entry?.modeStack?.length) continue;
    const stack = entry.modeStack;
    if (store.DmBlockMap.preventShade.includes(stack.at(-1).mode) && state.preventshade !== entry.preventShade) {
      entry.preventShade = state.preventshade;
      if (state.preventshade && entry.index > 0) Object.assign(source, stack[--entry.index]);
      else if (!state.preventshade && entry.index < stack.length - 1) Object.assign(source, stack[++entry.index]);
    }
    if (entry.blockColor !== !state.typeColor) {
      entry.blockColor = !state.typeColor;
      source.color = entry.blockColor ? 0xffffff : entry.color;
    }
  }
}

test('owned projects native color and mode preparation without starving its formal batch or a later seek', t => {
  const timeline = [item(1, 4.2, '颜色中文', { color: 0xff1234, speed: 68 }),
    item(2, 4.3, '底部中文', { mode: 4, rawMode: 4 }), item(3, 4.4, '屏蔽内容')];
  const pool = structuredClone(timeline);
  const f = fixture(timeline, pool, { realRules: true, beforeRender: prepareNativeShadeAndColor });
  t.after(() => f.attachment.stop());
  Object.assign(f.blockStore.dmSettingStore.state, { typeColor: false, preventshade: true });
  f.blockStore.blockList.push({ type: 0, filter: '屏蔽', opened: true });
  for (const source of timeline) f.blockStore.dmMap.set(source.dmid, {
    modeStack: [{ mode: 1, rawMode: 1 }, { mode: source.mode, rawMode: source.rawMode }], index: 1,
    blockColor: false, blockSpecial: false, blockTopBottom: false, preventShade: false,
    color: source.color,
  });
  const history = structuredClone(f.blockStore.dmMap);
  assert.equal(f.rules.read().match(timeline[0]).reason, 'mode-stack-adjustment', 'passive Shadow stays conservative');
  f.startPlanned();
  assert.deepEqual(f.shadow().items.map(row => row.sourceId), ['1', '2']);
  assert.deepEqual(f.blockStore.dmMap, history, 'planning does not execute the native history hook');
  assert.equal(timeline[0].color, 0xff1234); assert.equal(timeline[1].mode, 4);
  assert.equal(f.hooks.length, 0);
  f.readyPlanned(timeline[0]); f.readyPlanned(timeline[1]);
  f.setTime(4, 2000); f.resetPlaybackWrites(); f.manager.fetchAndInitDm(4);
  assert.deepEqual(f.models.map(model => model.text), ['訳1', '訳2']);
  assert.deepEqual(f.filtered.map(row => [row.text, row.author]), [['颜色中文', 'author-1'], ['底部中文', 'author-2']]);
  assert.equal(f.models[0].textData.color, 0xffffff); assert.equal(f.models[0].textData.speed, 68);
  assert.equal(f.models[1].textData.mode, 1); assert.equal(f.models[1].textData.rawMode, 1);
  assert.equal(pool[0].color, 0xff1234); assert.equal(pool[1].mode, 4);
  assert.deepEqual(timeline.map(row => row.text), pool.map(row => row.text));
  assert.deepEqual(f.playbackWrites, { pauseCalls: 0, playCalls: 0, timeWrites: 0, rateWrites: 0 });
  for (const model of f.models) model.textData.on = false;
  f.seek(0); f.resetPlaybackWrites(); f.attachment.tick();
  assert.deepEqual(f.shadow().items.map(row => row.sourceId), ['1', '2'],
    'native presentation changes must not invalidate the stale Worker copy identity after seek');
  assert.deepEqual(f.playbackWrites, { pauseCalls: 0, playCalls: 0, timeWrites: 0, rateWrites: 0 });
});

test('owned density uses the projected mode and native rejection remains terminal', t => {
  const timeline = [item(1, 4.2, '底部一', { mode: 4, rawMode: 4 }),
    item(2, 4.3, '底部二', { mode: 4, rawMode: 4 })];
  const f = fixture(timeline, structuredClone(timeline), { realRules: true,
    beforeRender: prepareNativeShadeAndColor, nativeFilter: () => false });
  t.after(() => f.attachment.stop());
  f.manager.containerSize.height = 28.125;
  f.blockStore.dmSettingStore.state.preventshade = true;
  for (const source of timeline) f.blockStore.dmMap.set(source.dmid, {
    modeStack: [{ mode: 1, rawMode: 1 }, { mode: 4, rawMode: 4 }], index: 1,
    blockColor: false, blockSpecial: false, blockTopBottom: false, preventShade: false,
  });
  f.startPlanned(); assert.deepEqual(f.shadow().items.map(row => row.sourceId), ['1']);
  f.readyPlanned(); f.setTime(4, 2000); f.resetPlaybackWrites(); f.manager.fetchAndInitDm(4);
  assert.equal(f.filtered[0].item.mode, 1, 'native filter runs after actual preparation');
  assert.equal(f.models.length, 0);
  assert.equal(f.attachment.nativeSupply.report().counts.nativeRejected, 1);
  f.manager.insert([timeline[0]]); assert.equal(f.filtered.length, 1, 'native refusal cannot replay a paid result');
  assert.deepEqual(f.playbackWrites, { pauseCalls: 0, playCalls: 0, timeWrites: 0, rateWrites: 0 });
});

test('unexpected native preparation cannot leak original text or adopt under changed identity', t => {
  for (const patch of [{ mode: 7, rawMode: 7 }, { uhash: 'wrong-author' }, { uid: 'wrong-uid' },
    { dmid: '999' }, { text: '不同原文' }, { stime: 4.8 }, { speed: 999 }]) {
    const source = item(1, 4.5);
    const f = fixture([source], undefined, { beforeRender: rows => Object.assign(rows[0], patch) });
    t.after(() => f.attachment.stop());
    f.startPlanned(); f.readyPlanned(); f.setTime(4, 2000); f.resetPlaybackWrites();
    f.manager.fetchAndInitDm(4);
    assert.equal(f.models.length, 0, JSON.stringify(patch)); assert.equal(source.on, false);
    const event = f.attachment.nativeSupply.report().events.find(row => row.reason === 'native-preparation-mismatch');
    assert.equal(event?.sourceId, '1', 'close the original subscription even if native changed its dmid');
    assert.equal(event?.originalText, '中文1');
    assert.deepEqual(f.playbackWrites, { pauseCalls: 0, playCalls: 0, timeWrites: 0, rateWrites: 0 });
  }
});

test('five-second buckets seal once, preserve exact identity, and use density and weight', t => {
  const list = [item(1, .5, '第一'), item(2, .6, '第二', { weight: 99 }),
    item(3, 1.5, '第三'), item(4, 5.5, '远期')];
  const f = fixture(list); t.after(() => f.attachment.stop());
  f.setting.limit = 5; // One row per media-time bucket, not a fixed two per second.
  const updates = [], owned = f.owned(updates);
  owned.tick(0);
  assert.deepEqual(updates.at(-1).items.map(x => x.sourceId), ['3']);
  assert.equal(owned.matches(list[1]), true, 'weighted selection is sealed even when its immediate deadline has passed');
  assert.equal(owned.report().selected, 2);
  assert.equal(owned.report().rejected['density-cap'], 1);
  const late = item(5, .7, 'later segment'); list.push(late);
  f.setTime(.1, 1100); owned.tick(0);
  assert.equal(updates.at(-1).items.some(x => x.sourceId === '5'), false, 'sealed bucket cannot be revised');
  f.setTime(1, 2000); owned.tick(0);
  assert.equal(updates.at(-1).items.some(x => x.sourceId === '4'), true, 'a full later bucket enters the horizon');
  assert.equal(owned.matches(list[0]), false);
  assert.equal(owned.matches(list[1]), false, 'elapsed selected row is terminally missed');
});

test('rate preserves owned generations while rule and playback epoch still invalidate them', t => {
  const f = fixture([item(1, 3), item(2, 3.5)]); t.after(() => f.attachment.stop());
  const updates = [], owned = f.owned(updates);
  f.setRule(source => source.dmid === '1' ? { state: 'unknown', reason: 'sender-contract-unknown' }
    : { state: 'retain', reason: 'allowed' });
  owned.tick(0);
  assert.deepEqual(updates.at(-1).items.map(x => x.sourceId), ['2']);
  assert.equal(owned.report().rejected['sender-contract-unknown'], 1);
  const generation = updates.at(-1).predictionEpoch;
  f.video.playbackRate = 2; owned.tick(0);
  assert.equal(updates.at(-1).predictionEpoch, generation);
  f.setRule(() => ({ state: 'retain', reason: 'allowed' }), 6); owned.tick(0);
  assert.deepEqual(updates.at(-1).items.map(x => x.sourceId), ['1', '2']);
  const ruleGeneration = updates.at(-1).predictionEpoch;
  owned.tick(1);
  assert.ok(updates.at(-1).predictionEpoch > ruleGeneration);
  f.setRuleKnown(false); owned.tick(1);
  assert.equal(updates.at(-1).known, false);
  assert.equal(owned.report().reason, 'rules-unavailable');
});

test('held speed round trips never extend a deadline or refill a sealed density allowance', t => {
  const rows = [item(1, 4.5), item(2, 4.6), item(3, 4.7)];
  const f = fixture(rows); t.after(() => f.attachment.stop());
  f.setting.limit = 5;
  const updates = [], owned = f.owned(updates);
  owned.tick(0);
  const before = updates.at(-1);
  assert.deepEqual(before.items.map(row => row.sourceId), ['1']);
  f.video.playbackRate = 2; owned.tick(0);
  const fastDeadline = updates.at(-1).items[0].deadlineAtEpochMs;
  assert.ok(fastDeadline < before.items[0].deadlineAtEpochMs);
  for (const rate of [1, 2, 1, 3, 1]) { f.video.playbackRate = rate; owned.tick(0); }
  const after = updates.at(-1);
  assert.equal(after.predictionEpoch, before.predictionEpoch);
  assert.deepEqual(after.items.map(row => row.sourceId), ['1']);
  assert.ok(after.items[0].deadlineAtEpochMs <= fastDeadline);
  assert.equal(owned.report().totals.selected, 1);
});

test('a speed changed while paused tightens the existing lease on resume', t => {
  const f = fixture([item(1, 4.5)]); t.after(() => f.attachment.stop());
  const updates = [], owned = f.owned(updates);
  owned.tick(0);
  const generation = updates.at(-1).predictionEpoch;
  f.video.paused = true; owned.tick(0);
  f.video.playbackRate = 2; owned.tick(0);
  f.advanceWall(1000); owned.tick(0);
  f.video.paused = false; owned.tick(0);
  assert.equal(updates.at(-1).predictionEpoch, generation);
  assert.equal(updates.at(-1).items[0].deadlineAtEpochMs, 3250);
});

test('formal fetch supplies selected pool object despite changing native candidates, once, with original filter metadata', t => {
  const selected = item(1, 4.5, '中文', { speed: 68, size: 28 });
  const competing = item(2, 4.5, '另一个');
  const advanced = item(9, 4.5, 'advanced', { mode: 7, rawMode: 7 });
  const f = fixture([selected, competing, advanced]); t.after(() => f.attachment.stop()); f.start();
  assert.equal(f.clearCalls, 1);
  f.ready(selected);
  f.setNativeCandidates([competing, advanced]);
  f.setTime(4, 2000);
  assert.equal(f.manager.fetchAndInitDm(4), 'fetched');
  assert.equal(f.fetchCalls, 1);
  assert.equal(f.manager.lastTime, 5);
  assert.ok(f.hooks[0].includes(selected));
  assert.equal(f.filtered.find(x => x.item === selected).author, 'author-1');
  const translated = f.models.find(x => x.text === '訳1');
  assert.ok(translated);
  assert.equal(translated.textData.speed, 68);
  assert.equal(translated.textData.size, 28);
  assert.equal(selected.text, '中文');
  assert.equal(translated.textData.on, true);
  assert.equal(f.filtered.some(x => x.item === competing), false);
  assert.equal(f.filtered.some(x => x.item === advanced), true);
  selected.on = false;
  f.manager.fetchAndInitDm(4);
  assert.equal(f.models.filter(x => x.text === '訳1').length, 1);
  assert.equal(f.attachment.nativeSupply.report().counts.adopted, 1);
});

test('Worker-cloned pool admits the original timeline source through native filtering and releases its on state', t => {
  const timeline = [item(1, 4.5, '中文', { speed: 68, size: 28 }),
    ...Array.from({ length: 273 }, (_, index) => item(index + 2, 80 + index / 10))];
  const pool = structuredClone(timeline);
  assert.equal(timeline.length, 274);
  assert.ok(timeline.every((source, index) => source !== pool[index]));
  const f = fixture(timeline, pool); t.after(() => f.attachment.stop()); f.start();
  assert.equal(f.shadow().items.some(row => row.id === idOf(1)), true);
  f.ready(timeline[0]);
  f.setNativeCandidates([pool[1]]);
  f.setTime(4, 2000);
  f.manager.fetchAndInitDm(4);
  assert.equal(f.filtered[0].item, timeline[0]);
  assert.equal(f.filtered[0].text, '中文');
  assert.equal(f.filtered[0].author, 'author-1');
  assert.equal(f.models[0].text, '訳1');
  assert.notEqual(f.models[0].textData, timeline[0]);
  assert.equal(f.models[0].textData.speed, 68);
  assert.equal(timeline[0].text, '中文');
  assert.equal(timeline[0].on, true);
  assert.equal(pool[0].on, false, 'the cloned pool does not own native on state');
  f.models[0].textData.on = false;
  assert.equal(timeline[0].on, false, 'translated copy releases the native timeline source');
  f.manager.fetchAndInitDm(4);
  assert.equal(f.models.length, 1, 'a completed source cannot be supplied twice');
  assert.equal(f.attachment.nativeSupply.report().counts.adopted, 1);
});

test('cross-pool identity rejects missing or conflicting author, text, and duplicate IDs', t => {
  for (const change of [
    pool => { delete pool[0].uhash; },
    pool => { pool[0].uhash = 'other-author'; },
    pool => { pool[0].text = '另一原文'; },
    pool => { pool.push(structuredClone(pool[0])); },
  ]) {
    const timeline = [item(1, 4.5)], pool = structuredClone(timeline);
    change(pool);
    const f = fixture(timeline, pool); t.after(() => f.attachment.stop());
    const updates = [], owned = f.owned(updates); owned.tick(0);
    assert.deepEqual(updates.at(-1).items, []);
    assert.equal(owned.report().rejected['membership-rejected'], 1);
    assert.deepEqual(owned.candidates(4, 1, 1), []);
    assert.equal(owned.matches(timeline[0]), false);
  }
  const timeline = [item(1, 4.5), item(1, 4.5)];
  const duplicate = fixture(timeline, structuredClone([timeline[0]]));
  t.after(() => duplicate.attachment.stop());
  const updates = [], owned = duplicate.owned(updates); owned.tick(0);
  assert.deepEqual(updates.at(-1).items, []);
  assert.ok(owned.report().rejected['membership-rejected'] > 0);
});

test('removal, timeline replacement, and changed metadata revoke a selected cloned-pool source', t => {
  for (const change of [
    f => { f.manager.dataBase.dmArray.length = 0; },
    f => { f.manager.dataBase.timeLine.list = structuredClone(f.list); },
    f => { f.manager.dataBase.dmArray[0].speed = 99; },
    f => { f.list[0].uhash = 'changed-author'; },
  ]) {
    const timeline = [item(1, 4.5, '中文', { speed: 68 })];
    const f = fixture(timeline, structuredClone(timeline)); t.after(() => f.attachment.stop());
    const owned = f.owned([]); owned.tick(0);
    assert.equal(owned.matches(timeline[0]), true);
    change(f);
    assert.deepEqual(owned.candidates(4, 1, 1), []);
    assert.equal(owned.matches(timeline[0]), false);
  }
});

test('a changed or missing cloned-pool source retracts the pending prediction and closes it once', t => {
  for (const change of [
    f => { f.manager.dataBase.dmArray[0].text = '变动的原文'; },
    f => { f.manager.dataBase.dmArray[0].uhash = 'other-author'; },
    f => { f.manager.dataBase.dmArray.length = 0; },
  ]) {
    const timeline = [item(1, 4.5)];
    const f = fixture(timeline, structuredClone(timeline)); t.after(() => f.attachment.stop());
    const updates = [], misses = [];
    const owned = f.owned(updates, (...args) => misses.push(args));
    owned.tick(0);
    assert.equal(updates.at(-1).items.length, 1);
    change(f);
    owned.tick(0);
    assert.deepEqual(updates.at(-1).items, []);
    assert.equal(owned.report().totals.missed, 1);
    assert.equal(owned.report().rejected['membership-rejected'], 1);
    assert.equal(misses[0][4], 'source-membership-changed');
    owned.tick(0);
    assert.equal(misses.length, 1);
  }
  const timeline = [item(1, 4.5)];
  const f = fixture(timeline, structuredClone(timeline)); t.after(() => f.attachment.stop());
  const misses = [], owned = f.owned([], (...args) => misses.push(args));
  owned.tick(0);
  timeline[0].uhash = 'changed-author';
  f.manager.dataBase.dmArray.length = 0;
  owned.tick(0);
  assert.equal(misses[0][4], 'source-metadata-changed', 'timeline mutation retains precedence');
});

test('future candidates remain pending; missing text at the first window closes without native quota use', t => {
  const selected = item(1, 4.5, '中文');
  const f = fixture([selected]); t.after(() => f.attachment.stop()); f.start();
  f.setTime(2, 1500);
  f.manager.insert([selected]);
  assert.equal(f.filtered.length, 0, 'future add candidate cannot reach the native filter');
  f.setTime(4, 2000);
  f.manager.fetchAndInitDm(4);
  assert.equal(f.filtered.length, 0, 'missing result is suppressed before the native insert');
  assert.equal(f.attachment.nativeSupply.report().counts.nativeAdmissionOpportunity, undefined);
  assert.equal(f.attachment.nativeSupply.report().counts.ownedSuppressed, 2);
  assert.equal(f.attachment.nativeSupply.report().events.findLast(x => x.type === 'ownedSuppressed').closed, true);
  f.manager.insert([selected]);
  assert.equal(f.models.length, 0, 'a missing result cannot later revive the event');
  f.setTime(6, 4000); f.attachment.tick(); f.manager.insert([selected]);
  assert.equal(f.models.length, 0);
  assert.equal(f.filtered.length, 0);
});

test('a selected and prepared row may enter once through add inside its current window', t => {
  const source = item(1, 4.5);
  const f = fixture([source]); t.after(() => f.attachment.stop()); f.start(); f.ready();
  f.setTime(4, 2000); f.manager.insert([source]);
  assert.equal(f.models.length, 1);
  assert.equal(f.models[0].text, '訳1');
  source.on = false; f.manager.insert([source]);
  assert.equal(f.models.length, 1);
  assert.equal(f.filtered.length, 1);
});

test('a missed row stays out of native batches, and native rejection closes a supplied event', t => {
  const missed = fixture([item(1, 4.5)]); t.after(() => missed.attachment.stop()); missed.start();
  missed.setTime(5.2, 3000); missed.attachment.tick();
  missed.setNativeCandidates([missed.list[0]]); missed.manager.fetchAndInitDm(5.2);
  assert.equal(missed.filtered.length, 0);
  assert.equal(missed.attachment.nativeSupply.report().counts.ownedMiss, 1);

  const f = fixture([item(1, 4.5)]); t.after(() => f.attachment.stop()); f.start(); f.ready();
  f.setReject(true); f.setTime(4, 2000); f.manager.fetchAndInitDm(4);
  assert.equal(f.models.length, 0);
  assert.equal(f.attachment.nativeSupply.report().counts.nativeRejected, 1);
  f.setReject(false); f.manager.insert([f.list[0]]);
  assert.equal(f.models.length, 0, 'an official rejection is terminal for the supplied event');
  const wrapped = f.manager.fetchAndInitDm;
  const restored = f.attachment.stop();
  assert.equal(restored.laterWrapperPreserved, false);
  assert.notEqual(f.manager.fetchAndInitDm, wrapped);
});

test('owned contract loss pauses rather than feeding original text to native', t => {
  const f = fixture(); t.after(() => f.attachment.stop()); f.start();
  f.setRuleKnown(false); f.attachment.tick();
  assert.equal(f.attachment.nativeSupply.state, 'paused');
  assert.equal(f.pauseCalls, 1);
  f.manager.insert([f.list[0]]);
  assert.equal(f.filtered.length, 0);
});

test('a complete armed owned control leaves playback on and starts planning only after running', t => {
  const f = fixture([item(1, 4.5), item(2, 1.5)]); t.after(() => f.attachment.stop());
  f.content({ type: 'control', generation: 0, enabled: true, displayMode: 'translated',
    bilibiliOwnedRelease: true, bilibiliShadowScheduler: false,
    nativeSupply: { ...control, state: 'armed' } });
  f.attachment.tick();
  assert.equal(f.video.paused, false);
  assert.equal(f.pauseCalls, 0);
  assert.equal(f.attachment.nativeSupply.state, 'armed');
  assert.equal(f.shadow(), undefined, 'waiting must not request future translation');
  f.manager.fetchAndInitDm(0);
  f.setTime(2, 1500);
  f.attachment.tick();
  f.manager.insert(f.list);
  assert.equal(f.filtered.length, 0);
  assert.equal(f.models.length, 0);
  assert.equal(f.attachment.nativeSupply.report().terminal, 0);
  assert.equal(f.attachment.nativeSupply.report().counts.ownedSuppressed, undefined);
  const advanced = item(9, 2.5, 'advanced', { mode: 7, rawMode: 7 });
  f.manager.insert([advanced]);
  assert.equal(f.models[0].text, 'advanced', 'nonordinary native content stays outside owned admission');

  f.content({ type: 'control', generation: 0, enabled: true, displayMode: 'translated',
    bilibiliOwnedRelease: true, bilibiliShadowScheduler: false, nativeSupply: control });
  f.attachment.tick();
  assert.equal(f.pauseCalls, 0);
  assert.equal(f.shadow()?.items.some(row => row.id === idOf(1)), true);
  assert.equal(f.shadow()?.items.some(row => row.id === idOf(2)), false, 'past events must stay past');
  f.ready();
  f.setTime(4, 2000);
  f.manager.fetchAndInitDm(4);
  assert.equal(f.models.length, 2);
  assert.equal(f.models[1].text, '訳1');
  assert.equal(f.attachment.nativeSupply.report().counts.adopted, 1);
});

test('missing owned control during armed waiting still pauses playback', t => {
  const f = fixture(); t.after(() => f.attachment.stop());
  f.content({ type: 'control', generation: 0, enabled: true, displayMode: 'translated',
    bilibiliOwnedRelease: true, bilibiliShadowScheduler: false,
    nativeSupply: { ...control, state: 'armed' } });
  f.content({ type: 'control', generation: 0, enabled: true, displayMode: 'translated',
    bilibiliOwnedRelease: true, bilibiliShadowScheduler: false });
  assert.equal(f.pauseCalls, 1);
  assert.equal(f.attachment.nativeSupply.state, 'paused');
  f.manager.insert([f.list[0]]);
  assert.equal(f.filtered.length, 0);
  assert.equal(f.models.length, 0);
});

test('selected text classified as not needing translation reaches native unchanged', t => {
  const emoji = item(1, 4.5, '👍👍');
  const f = fixture([emoji]); t.after(() => f.attachment.stop()); f.start();
  f.setTime(4, 2000); f.manager.fetchAndInitDm(4);
  assert.equal(f.filtered.length, 1);
  assert.equal(f.filtered[0].item, emoji);
  assert.equal(f.models[0].text, '👍👍');
  assert.equal(f.attachment.nativeSupply.report().counts.unneeded, 1);
  assert.equal(f.attachment.nativeSupply.report().counts.adopted, undefined);
});

test('a seek retires the old event and cannot use its previously prepared text', t => {
  const source = item(1, 4.5, '中文');
  const f = fixture([source]); t.after(() => f.attachment.stop()); f.start(); f.ready();
  f.seek(4); f.attachment.tick();
  assert.equal(f.attachment.epoch, 1);
  f.manager.insert([source]);
  assert.equal(f.filtered.length, 0);
  assert.equal(f.models.length, 0);
  assert.equal(f.attachment.nativeSupply.report().counts.adopted, undefined);
});

test('terminal rows leave the active map during long playback without exhausting its 2000-row cap', t => {
  const list = Array.from({ length: 2050 }, (_, index) => item(index + 1, index + .5));
  const f = fixture(list); t.after(() => f.attachment.stop());
  const updates = [], owned = f.owned(updates);
  for (let second = 0; second < 2050; second++) {
    f.setTime(second, 1000 + second * 1000);
    owned.tick(0);
  }
  const report = owned.report();
  assert.equal(report.known, true);
  assert.equal(report.totals.selected, 2050);
  assert.ok(report.selected < 10, 'old object references must be retired');
  assert.ok(report.sealedBuckets >= 2050);
});

test('suppressed and missed denominators stay distinct, and a moved terminal source is retired', t => {
  const suppressed = item(1, 4.5), moved = item(2, 4.6);
  const f = fixture([suppressed, moved]); t.after(() => f.attachment.stop());
  const owned = f.owned([]); owned.tick(0); owned.markSuppressed(suppressed);
  moved.stime = 20_000;
  f.setTime(5, 6000); owned.tick(0);
  assert.equal(owned.report().totals.suppressed, 1);
  assert.equal(owned.report().totals.missed, 1);
  f.setTime(8, 9000); owned.tick(0);
  assert.equal(owned.report().selected, 0, 'retire by the frozen original time, not a mutated source time');
  assert.equal(owned.report().totals.missed, 1);
});

test('author metadata changes invalidate a ready selection before original native filtering', t => {
  const source = item(1, 4.5);
  const f = fixture([source]); t.after(() => f.attachment.stop()); f.start(); f.ready();
  source.uhash = 'changed-author';
  f.setTime(4, 2000); f.manager.fetchAndInitDm(4);
  assert.equal(f.filtered.length, 0);
  assert.equal(f.models.length, 0);
  assert.equal(f.attachment.nativeSupply.report().events.find(x => x.type === 'ownedMiss').reason,
    'source-metadata-changed');
});

test('an already-active source retains its on state when owned preflight suppresses it', t => {
  const source = item(1, 4.5);
  const f = fixture([source]); t.after(() => f.attachment.stop()); f.start(); f.ready();
  source.on = true;
  f.setTime(4, 2000); f.manager.fetchAndInitDm(4);
  assert.equal(f.filtered.length, 0);
  assert.equal(source.on, true);
  assert.equal(f.attachment.nativeSupply.report().events.findLast(x => x.type === 'ownedSuppressed').reason,
    'already-active');
});

test('partial user-rule unknown retains reason but still submits original author to native rejection', t => {
  const source = item(1, 4.5, '中文', { uhash: 'blocked-author' });
  const f = fixture([source]); t.after(() => f.attachment.stop());
  f.setRule(() => ({ state: 'unknown', reason: 'user-sender-partial' }));
  f.start();
  assert.deepEqual(f.shadow().items[0].reasons, ['user-sender-partial']);
  f.ready(); f.setReject(true); f.setTime(4, 2000); f.manager.fetchAndInitDm(4);
  assert.equal(f.filtered[0].text, '中文');
  assert.equal(f.filtered[0].author, 'blocked-author');
  assert.equal(f.models.length, 0);
  assert.equal(f.attachment.nativeSupply.report().counts.nativeRejected, 1);
});

test('lost method ownership pauses owned supply and preserves a later wrapper on stop', t => {
  const f = fixture(); t.after(() => f.attachment.stop()); f.start();
  const wrapped = f.manager.insert;
  const later = function (...args) { return Reflect.apply(wrapped, this, args); };
  f.manager.insert = later;
  f.attachment.tick();
  assert.equal(f.pauseCalls, 1);
  assert.equal(f.attachment.nativeSupply.report().pausedReason, 'owned-hook-ownership-lost');
  const result = f.attachment.stop();
  assert.equal(result.laterWrapperPreserved, true);
  assert.equal(f.manager.insert, later);
});

test('planned control supplies the original timeline through formal native fetch without playback writes', t => {
  const source = item(1, 4.5, '中文', { speed: 68, size: 28 });
  const competing = item(2, 4.5, '竞争弹幕');
  const timeline = [source, competing, item(9, 4.5, '特殊弹幕', { mode: 7, rawMode: 7 })];
  const f = fixture(timeline, structuredClone(timeline)); t.after(() => f.attachment.stop());
  f.startPlanned(); f.readyPlanned(source);
  f.setNativeCandidates([competing, timeline[2]]);
  f.setTime(4, 2000); f.resetPlaybackWrites();
  f.manager.fetchAndInitDm(4);
  assert.equal(f.clearCalls, 0);
  assert.equal(f.fetchCalls, 1);
  assert.equal(f.filtered.find(row => row.item === source)?.author, 'author-1');
  const translated = f.models.find(model => model.text === '訳1');
  assert.ok(translated);
  assert.equal(translated.textData.speed, 68);
  assert.equal(translated.textData.size, 28);
  assert.equal(source.text, '中文');
  assert.equal(f.models.some(model => model.text === '特殊弹幕'), true);
  assert.equal(f.attachment.nativeSupply.report().planned, true);
  assert.equal(f.attachment.nativeSupply.report().runId, null);
  assert.equal(f.attachment.nativeSupply.report().instanceId, null);
  assert.equal(f.attachment.nativeSupply.report().counts.adopted, 1);
  assert.deepEqual(f.playbackWrites, { pauseCalls: 0, playCalls: 0, timeWrites: 0, rateWrites: 0 });
});

test('planned missing translation closes the ordinary event while disabled control restores native rendering', t => {
  const source = item(1, 4.5);
  const f = fixture([source]); t.after(() => f.attachment.stop()); f.startPlanned();
  f.setTime(4, 2000); f.resetPlaybackWrites();
  f.manager.fetchAndInitDm(4);
  assert.equal(f.models.length, 0);
  assert.equal(f.filtered.length, 0);
  assert.equal(f.attachment.nativeSupply.report().counts.ownedSuppressed, 1);
  f.readyPlanned(source);
  f.manager.insert([source]);
  assert.equal(f.models.length, 0, 'late text cannot revive a closed event');
  assert.deepEqual(f.playbackWrites, { pauseCalls: 0, playCalls: 0, timeWrites: 0, rateWrites: 0 });

  f.content({ type: 'control', generation: 1, enabled: false, displayMode: 'original',
    bilibiliOwnedRelease: false });
  assert.equal(f.attachment.nativeSupply.active, false);
  f.manager.insert([source]);
  assert.equal(f.models.at(-1)?.text, source.text);
  assert.deepEqual(f.playbackWrites, { pauseCalls: 0, playCalls: 0, timeWrites: 0, rateWrites: 0 });
});

test('planned faults, missing control, and expired lease keep suppression without playback mutation', async t => {
  const cases = [
    { name: 'rules unavailable', fail: f => { f.setRuleKnown(false); f.attachment.tick(); }, reason: 'owned-rules-unavailable' },
    { name: 'missing heartbeat field', fail: f => f.content({ type: 'control', generation: 0,
      enabled: true, displayMode: 'translated', bilibiliOwnedRelease: true }), reason: 'invalid-planned-control' },
    { name: 'expired lease', fail: f => { f.setTime(8, 9000); f.resetPlaybackWrites(); f.attachment.tick(); },
      reason: 'control-lease-expired' },
    { name: 'hook lost', fail: f => { const wrapped = f.manager.insert;
      f.manager.insert = function (...args) { return Reflect.apply(wrapped, this, args); }; f.attachment.tick(); },
      reason: 'owned-hook-ownership-lost' },
  ];
  for (const scenario of cases) await t.test(scenario.name, t => {
    const f = fixture(); t.after(() => f.attachment.stop()); f.startPlanned();
    f.resetPlaybackWrites(); scenario.fail(f); f.attachment.tick();
    assert.equal(f.attachment.nativeSupply.fault, scenario.reason);
    f.manager.insert([f.list[0]]);
    assert.equal(f.models.length, 0);
    assert.deepEqual(f.playbackWrites, { pauseCalls: 0, playCalls: 0, timeWrites: 0, rateWrites: 0 });
    assert.equal(f.messages.findLast(x => x.type === 'snapshot')?.nativeSupply?.report?.pausedReason, scenario.reason);
  });
});

test('planned prepared result rejects stale epoch, rule generation, and configuration', t => {
  for (const stale of ['epoch', 'prediction', 'config']) {
    const f = fixture(); t.after(() => f.attachment.stop()); f.startPlanned();
    if (stale === 'epoch') f.readyPlanned(f.list[0], { epoch: f.attachment.epoch + 1 });
    if (stale === 'prediction') f.readyPlanned(f.list[0], { predictionEpoch: f.shadow().predictionEpoch + 1 });
    if (stale === 'config') f.readyPlanned(f.list[0], { configIdentity: 'old-config' });
    f.setTime(4, 2000); f.resetPlaybackWrites(); f.manager.fetchAndInitDm(4);
    assert.equal(f.models.length, 0, stale);
    assert.equal(f.attachment.nativeSupply.report().counts.adopted, undefined, stale);
    assert.deepEqual(f.playbackWrites, { pauseCalls: 0, playCalls: 0, timeWrites: 0, rateWrites: 0 });
  }
});

test('planned seek, hidden player, and changed source suppress without playback writes', async t => {
  for (const scenario of [
    { name: 'seek', change: f => { f.seek(2); f.attachment.tick(); } },
    { name: 'hidden', change: f => { f.manager.container.ownerDocument.hidden = true; f.attachment.tick(); } },
    { name: 'source changed', change: f => { f.list[0].uhash = 'changed-author'; f.attachment.tick(); } },
  ]) await t.test(scenario.name, t => {
    const f = fixture(); t.after(() => f.attachment.stop()); f.startPlanned(); f.readyPlanned();
    scenario.change(f);
    f.setTime(4, 2000); f.resetPlaybackWrites(); f.manager.fetchAndInitDm(4);
    assert.equal(f.models.length, 0);
    assert.equal(f.filtered.length, 0);
    assert.deepEqual(f.playbackWrites, { pauseCalls: 0, playCalls: 0, timeWrites: 0, rateWrites: 0 });
  });
});

test('planned rule fault recovers on a known native rule scope without replaying old result', t => {
  const f = fixture(); t.after(() => f.attachment.stop()); f.startPlanned(); f.readyPlanned();
  f.setRuleKnown(false); f.attachment.tick();
  assert.equal(f.attachment.nativeSupply.fault, 'owned-rules-unavailable');
  f.setRuleKnown(true); f.setRule(() => ({ state: 'retain', reason: 'allowed' }), 5);
  f.attachment.tick();
  assert.equal(f.attachment.nativeSupply.fault, null);
  assert.equal(f.attachment.nativeSupply.report().ready, 0);
  f.setTime(4, 2000); f.resetPlaybackWrites(); f.manager.fetchAndInitDm(4);
  assert.equal(f.models.length, 0, 'old rule revision never becomes supply after recovery');
  assert.deepEqual(f.playbackWrites, { pauseCalls: 0, playCalls: 0, timeWrites: 0, rateWrites: 0 });
});

test('late planned prepared is ignored after switching to ordinary translation', t => {
  const f = fixture(); t.after(() => f.attachment.stop()); f.startPlanned();
  const selected = f.shadow().items[0];
  f.content({ type: 'control', generation: 1, enabled: true, displayMode: 'translated',
    bilibiliOwnedRelease: false });
  f.content({ type: 'prepared', generation: 1, plannedSupply: true, items: [{
    id: selected.id, sourceId: selected.sourceId, originalText: selected.originalText,
    text: '旧计划译文', status: 'translated', epoch: f.attachment.epoch,
    predictionEpoch: f.shadow().predictionEpoch, ruleRevision: f.shadow().ruleRevision,
    deadlineAtEpochMs: selected.deadlineAtEpochMs, configIdentity: plannedSupply.configIdentity,
  }] });
  f.resetPlaybackWrites(); f.manager.insert([f.list[0]]);
  assert.equal(f.models[0].text, f.list[0].text);
  assert.deepEqual(f.playbackWrites, { pauseCalls: 0, playCalls: 0, timeWrites: 0, rateWrites: 0 });
});

test('missing first planned envelope fails closed without entering diagnostic playback pause', t => {
  const f = fixture(); t.after(() => f.attachment.stop());
  f.content({ type: 'control', generation: 0, enabled: true, displayMode: 'translated',
    bilibiliOwnedRelease: true });
  f.attachment.tick(); f.manager.insert([f.list[0]]);
  assert.equal(f.attachment.nativeSupply.planned, true);
  assert.equal(f.attachment.nativeSupply.fault, 'invalid-planned-control');
  assert.equal(f.models.length, 0);
  assert.deepEqual(f.playbackWrites, { pauseCalls: 0, playCalls: 0, timeWrites: 0, rateWrites: 0 });
});

test('a valid heartbeat renews an expired planned lease without replaying old text', t => {
  const f = fixture([item(1, 4.5), item(2, 12)]); t.after(() => f.attachment.stop());
  f.startPlanned(); f.readyPlanned();
  f.setTime(8, 9000); f.resetPlaybackWrites(); f.attachment.tick();
  assert.equal(f.attachment.nativeSupply.fault, 'control-lease-expired');
  f.content({ type: 'control', generation: 0, enabled: true, displayMode: 'translated',
    bilibiliOwnedRelease: true, plannedSupply });
  f.attachment.tick();
  assert.equal(f.attachment.nativeSupply.fault, null);
  assert.equal(f.attachment.nativeSupply.report().ready, 0);
  assert.deepEqual(f.playbackWrites, { pauseCalls: 0, playCalls: 0, timeWrites: 0, rateWrites: 0 });
});
