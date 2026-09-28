import test from 'node:test';
import assert from 'node:assert/strict';
import { createBilibiliShadowRules } from '../../src/platforms/bilibili/shadow-rules.ts';
import { forecastBilibiliShadow } from '../../src/core/bilibili-shadow.ts';
import { USER_FILTER_NATIVE_CALLBACK, USER_FILTER_NATIVE_FUNCTIONS } from '../../src/platforms/bilibili/user-filter-contract.ts';

const REPORT_FILTER = 'function(n){var r;return null!=(r=this.reportFilter)&&!!r.length&&this.reportFilter.some(function(r){if(new RegExp(r).test(n.text))return!0})}';
const nativeFunction = source => new Function(`return (${source})`)();
const mobxGetterFactory = new Function('ed', 'n', 'return function(){return this[ed].getObservablePropValue_(n)}');
const BLOCK_MAP = {
  blockScroll: [1],
  blockTopBottom: [5, 4],
  blockColor: [2012, 2015, 2007, 2008, 2009, 2013, 2002, 2003, 2000, 2001, 2004, 5, 4, 1, 6],
  blockSpecial: [2005, 2012, 2015, 2002, 2003, 2000, 2001, 2004, 2006, 2013, 2008, 2009, 2011, 2007, 2014, 2010, 3000, 2016, 2017, 2018, 2020],
  preventShade: [4],
};

function fixture({ reportFilter = [], badBlockMap = false, invalidObservableField = null,
  allowPartialUserRules } = {}) {
  let aiLevelGetterCalls = 0, mobxGetterCalls = 0, invalidGetterCalls = 0;
  const stateValues = { status: true, dmarea: 50, dmdensity: 1, typeScroll: true,
    typeTopBottom: true, typeColor: true, typeSpecial: true, seniorMode: false, preventshade: false };
  const observableKey = Symbol('mobx-administration');
  const prototype = {};
  const state = Object.create(prototype);
  state[observableKey] = { getObservablePropValue_(key) { mobxGetterCalls++; return stateValues[key]; } };
  for (const key of Object.keys(stateValues)) {
    Object.defineProperty(prototype, key, { configurable: true, get: invalidObservableField === key
      ? function() { invalidGetterCalls++; return stateValues[key]; }
      : mobxGetterFactory(observableKey, key) });
  }
  const dmSettingStore = { state };
  Object.defineProperty(dmSettingStore, 'aiLevel', { configurable: true, get() {
    aiLevelGetterCalls++;
    if (stateValues.dmarea > 0 && stateValues.dmarea < 100) return 3;
    if (stateValues.dmdensity === 2 || stateValues.dmdensity === 3) return 2;
    if (stateValues.dmdensity === 1) return 3;
    return undefined;
  } });

  const blockStore = {
    blockList: [],
    aiJudge: nativeFunction('function(n,r){return this.totalFiltleredDm+=1,Math.abs(n.weight)<r&&(this.aiCloudBlockCount+=1,!0)}'),
    reportFilterReg: nativeFunction(REPORT_FILTER),
    reportFilter,
    dmSettingStore,
    DmBlockMap: { ...BLOCK_MAP },
    dmMap: new Map(),
    totalFiltleredDm: 0,
    aiCloudBlockCount: 0,
    dmBlockCount: 0,
    filterPassCount: 0,
    blockCountByReason: { word: 0, aiCloud: 0, reportFilter: 0 },
  };
  for (const [name, source] of Object.entries(USER_FILTER_NATIVE_FUNCTIONS))
    blockStore[name] = nativeFunction(source);
  if (badBlockMap) blockStore.DmBlockMap = { ...BLOCK_MAP, blockColor: [6] };

  const config = { setting: { visible: true, noDanmakuXTypes: [], limit: 300 },
    scene: { isMini: false }, fn: { filter: nativeFunction(USER_FILTER_NATIVE_CALLBACK) } };
  const manager = { config, validateCalls: 0, validate() { this.validateCalls++; return true; } };
  const danmaku = { manager };
  const player = {};
  const rootStore = { rootPlayer: player, danmakuStore: { danmakuX: danmaku }, blockStore, dmSettingStore };
  player.rootStore = rootStore;
  const rules = createBilibiliShadowRules({ player, danmaku, documentScope: 'test-page', now: () => 1,
    allowPartialUserRules });
  return { rules, state, stateValues, blockStore, dmSettingStore, manager,
    get aiLevelGetterCalls() { return aiLevelGetterCalls; },
    get mobxGetterCalls() { return mobxGetterCalls; }, get invalidGetterCalls() { return invalidGetterCalls; } };
}

const candidate = (extra = {}) => ({ mode: 1, dmid: '123', border: false, weight: 20,
  text: 'ordinary text', pool: 0, colorful: false, color: 0, ...extra });
const modeStackEntry = (extra = {}) => ({
  modeStack: [{ rawMode: 1, mode: 1 }, { rawMode: 1, mode: 1 }], index: 1,
  blockColor: false, blockSpecial: false, blockTopBottom: false, preventShade: false,
  ...extra,
});

function guardNativeFilterCalls(sample) {
  let calls = 0;
  Object.defineProperty(sample.blockStore, 'dmSettingStore', { configurable: true, get() { calls++; return sample.dmSettingStore; } });
  Object.defineProperty(sample.blockStore, 'blockList', { configurable: true, get() { calls++; return []; } });
  return () => calls;
}

test('runtime read accepts the reviewed native surfaces and derives aiLevel without calling its accessor', () => {
  const sample = fixture();
  const snapshot = sample.rules.read();
  assert.equal(snapshot.known, true, snapshot.reason ?? '');
  assert.deepEqual(snapshot.nativeSettings, { visible: true, noDanmakuXTypes: [], limit: 300, sceneIsMini: false });
  assert.equal(snapshot.match(candidate({ weight: -1 })).reason, 'native-ai-weight');
  assert.ok(sample.mobxGetterCalls > 0);
  assert.equal(sample.aiLevelGetterCalls, 0);
  assert.equal(sample.blockStore.totalFiltleredDm, 0);
});

test('border exception remains provable even when another global native surface is unknown', () => {
  const sample = fixture({ badBlockMap: true });
  const snapshot = sample.rules.read();
  assert.equal(snapshot.known, false);
  assert.equal(snapshot.reason, 'native-mode-map-unverified');
  assert.deepEqual(snapshot.match(candidate({ border: true, weight: -1 })), {
    state: 'retain', reason: 'native-border-exception',
  });
  assert.equal(snapshot.match(candidate()).state, 'unknown');
});

test('mode 6 color behavior uses native white-color conversion', () => {
  const sample = fixture();
  sample.stateValues.typeColor = false;
  const snapshot = sample.rules.read();
  assert.equal(snapshot.match(candidate({ mode: 6, color: 0xffffff })).state, 'retain');
  assert.deepEqual(snapshot.match(candidate({ mode: 6, color: 0xeeeeee })), {
    state: 'exclude', reason: 'native-color-filter',
  });
});

test('negative weights follow absolute AI comparison before the signed senior threshold', () => {
  const sample = fixture();
  const snapshot = sample.rules.read();
  assert.deepEqual(snapshot.match(candidate({ weight: -1 })), { state: 'exclude', reason: 'native-ai-weight' });
  assert.deepEqual(snapshot.match(candidate({ dmid: '124', weight: -2 })), { state: 'exclude', reason: 'native-ai-weight' });
  assert.deepEqual(snapshot.match(candidate({ dmid: '126', weight: -3 })), { state: 'retain', reason: 'no-native-rule-matched' });
  sample.stateValues.seniorMode = true;
  assert.deepEqual(sample.rules.read().match(candidate({ dmid: '125', weight: -12 })), {
    state: 'exclude', reason: 'native-senior-weight',
  });
  assert.equal(sample.aiLevelGetterCalls, 0);
});

test('report regex is matched from the snapshot without calling native filter methods', () => {
  const sample = fixture({ reportFilter: ['spam'] });
  const snapshot = sample.rules.read();
  const filterCalls = guardNativeFilterCalls(sample);
  const originalTest = RegExp.prototype.test;
  let spamTests = 0;
  RegExp.prototype.test = function(value) {
    if (this.source === 'spam') spamTests++;
    return Reflect.apply(originalTest, this, [value]);
  };
  let result;
  try { result = snapshot.match(candidate({ text: 'contains spam' })); }
  finally { RegExp.prototype.test = originalTest; }

  assert.deepEqual(result, { state: 'exclude', reason: 'native-report-rule' });
  assert.equal(spamTests, 1); // The compiled matcher tested once; reportFilterReg was not invoked.
  assert.equal(filterCalls(), 0);
  assert.equal(sample.blockStore.totalFiltleredDm, 0);
  assert.equal(sample.manager.validateCalls, 0);
});

test('unsupported report patterns, stack-adjusted candidates, and nonordinary modes stay unknown', () => {
  const invalidPattern = fixture({ reportFilter: ['['] });
  assert.equal(invalidPattern.rules.read().match(candidate()).state, 'unknown');

  const stackAdjusted = fixture();
  stackAdjusted.blockStore.dmMap.set('123', modeStackEntry({ blockColor: true }));
  assert.deepEqual(stackAdjusted.rules.read().match(candidate({ rawMode: 1 })), {
    state: 'unknown', reason: 'mode-stack-adjustment',
  });

  const nonordinary = fixture();
  assert.deepEqual(nonordinary.rules.read().match(candidate({ mode: 3 })), {
    state: 'unknown', reason: 'non-ordinary-mode',
  });

  const accessorMode = fixture();
  let reads = 0;
  const input = candidate();
  delete input.mode;
  Object.defineProperty(input, 'mode', { get() { reads++; return 1; } });
  assert.deepEqual(accessorMode.rules.read().match(input), { state: 'unknown', reason: 'mode-unavailable' });
  assert.equal(reads, 0);
});

test('an unchanged two-layer native mode stack does not hide ordinary rule decisions', () => {
  const sample = fixture();
  const entry = modeStackEntry();
  const item = candidate({ rawMode: 1 });
  const originalEntry = structuredClone(entry), originalItem = structuredClone(item);
  sample.blockStore.dmMap.set('123', entry);
  const snapshot = sample.rules.read();
  assert.deepEqual(snapshot.match(item), { state: 'retain', reason: 'no-native-rule-matched' });
  assert.deepEqual(entry, originalEntry);
  assert.deepEqual(item, originalItem);
  assert.equal(sample.blockStore.totalFiltleredDm, 0);
  assert.equal(sample.blockStore.dmBlockCount, 0);
  assert.equal(sample.manager.validateCalls, 0);
});

test('absent and empty native mode-stack values have no adjustment branch', () => {
  const sample = fixture();
  const item = candidate({ rawMode: 1 });
  const snapshot = sample.rules.read();
  for (const entry of [undefined, null, {}, { modeStack: null }, { modeStack: [] }]) {
    if (entry === undefined) sample.blockStore.dmMap.delete('123');
    else sample.blockStore.dmMap.set('123', entry);
    assert.deepEqual(snapshot.match(item), { state: 'retain', reason: 'no-native-rule-matched' });
  }
});

test('mode-stack history only matters when the native last-mode branch runs', () => {
  const sample = fixture();
  const item = candidate({ rawMode: 1, color: 0x123456 });
  const snapshot = sample.rules.read();
  for (const key of ['blockSpecial', 'blockTopBottom', 'preventShade']) {
    sample.blockStore.dmMap.set('123', modeStackEntry({ [key]: true }));
    assert.deepEqual(snapshot.match(item), { state: 'retain', reason: 'no-native-rule-matched' }, key);
  }
  sample.blockStore.dmMap.set('123', modeStackEntry({ blockColor: true }));
  assert.deepEqual(snapshot.match(item), { state: 'unknown', reason: 'mode-stack-adjustment' }, 'blockColor');
  sample.blockStore.dmMap.set('123', modeStackEntry({ modeStack: [
    { rawMode: 1, mode: 1 }, { rawMode: 2005, mode: 2005 },
  ], index: 0, blockSpecial: true }));
  assert.deepEqual(snapshot.match(item), { state: 'unknown', reason: 'mode-stack-adjustment' },
    'special branch uses the last stack mode, not the current index');
  const topBottom = candidate({ rawMode: 4, mode: 4 });
  for (const key of ['blockTopBottom', 'preventShade']) {
    sample.blockStore.dmMap.set('123', modeStackEntry({ modeStack: [
      { rawMode: 1, mode: 1 }, { rawMode: 4, mode: 4 },
    ], [key]: true }));
    assert.deepEqual(snapshot.match(topBottom), { state: 'unknown', reason: 'mode-stack-adjustment' }, key);
  }
  sample.blockStore.dmMap.set('123', modeStackEntry({ modeStack: [
    { rawMode: 1, mode: 1 }, { rawMode: 4, mode: 4 },
  ] }));
  assert.deepEqual(snapshot.match(item), { state: 'unknown', reason: 'mode-stack-adjustment' });
  assert.equal(item.color, 0x123456, 'a changed color setting must not modify native input');
  assert.equal(sample.blockStore.totalFiltleredDm, 0);
  assert.equal(sample.manager.validateCalls, 0);
});

test('irrelevant history accessors stay unread and unverified last modes fail closed', () => {
  const sample = fixture();
  const item = candidate({ rawMode: 1 });
  const snapshot = sample.rules.read();
  const entry = modeStackEntry();
  let getterCalls = 0;
  for (const key of ['blockSpecial', 'blockTopBottom', 'preventShade'])
    Object.defineProperty(entry, key, { get() { getterCalls++; throw Error('native history getter'); } });
  sample.blockStore.dmMap.set('123', entry);
  assert.deepEqual(snapshot.match(item), { state: 'retain', reason: 'no-native-rule-matched' });
  assert.equal(getterCalls, 0);
  sample.blockStore.dmMap.set('123', modeStackEntry({ modeStack: [
    { rawMode: 1, mode: 1 }, {},
  ], index: 0 }));
  assert.deepEqual(snapshot.match(item), { state: 'unknown', reason: 'mode-stack-state-unavailable' });
  const unverifiedMap = fixture({ badBlockMap: true });
  unverifiedMap.blockStore.dmMap.set('123', modeStackEntry());
  assert.deepEqual(unverifiedMap.rules.read().match(item), {
    state: 'unknown', reason: 'mode-stack-state-unavailable',
  });
});

test('owned projection follows native top-bottom movement and leaves shadow conservative', () => {
  const sample = fixture();
  sample.stateValues.typeTopBottom = false;
  const snapshot = sample.rules.read();
  const item = candidate({ mode: 4, rawMode: 4, color: 0x123456 });
  const entry = modeStackEntry({ modeStack: [
    { mode: 1, rawMode: 1 }, { mode: 4, rawMode: 4 },
  ] });
  sample.blockStore.dmMap.set('123', entry);
  assert.equal(snapshot.match(item).reason, 'mode-stack-adjustment');
  assert.deepEqual(snapshot.matchOwned(item), { state: 'retain', reason: 'no-native-rule-matched',
    projection: { mode: 1, rawMode: 1, color: 0x123456, colorfulImg: undefined } });
  assert.equal(item.mode, 4);
  assert.equal(entry.index, 1);
  assert.equal(entry.blockTopBottom, false);

  sample.stateValues.typeTopBottom = true;
  const restored = sample.rules.read();
  entry.index = 0; entry.blockTopBottom = true;
  const rolling = candidate({ mode: 1, rawMode: 1 });
  assert.deepEqual(restored.matchOwned(rolling), { state: 'retain', reason: 'no-native-rule-matched',
    projection: { mode: 4, rawMode: 4, color: 0, colorfulImg: undefined } });
  assert.equal(rolling.mode, 1);
});

test('owned projection preserves a mismatched current index when the native hook has no assignment', () => {
  const sample = fixture();
  const snapshot = sample.rules.read();
  const item = candidate({ mode: 1, rawMode: 1 });
  const entry = modeStackEntry({ modeStack: [
    { mode: 1, rawMode: 1 }, { mode: 4, rawMode: 4 },
  ] });
  sample.blockStore.dmMap.set('123', entry);
  assert.equal(snapshot.match(item).reason, 'mode-stack-adjustment');
  assert.deepEqual(snapshot.matchOwned(item), { state: 'retain', reason: 'no-native-rule-matched',
    projection: { mode: 1, rawMode: 1, color: 0, colorfulImg: undefined } });
  assert.equal(entry.index, 1);
});

test('owned color projection handles white override and undefined native restoration', () => {
  const sample = fixture();
  const item = candidate({ rawMode: 1, color: 0x123456, colorfulImg: '' });
  const entry = modeStackEntry({ color: 0x123456 });
  sample.blockStore.dmMap.set('123', entry);
  sample.stateValues.typeColor = false;
  const disabled = sample.rules.read();
  assert.deepEqual(disabled.matchOwned(item), { state: 'retain', reason: 'no-native-rule-matched',
    projection: { mode: 1, rawMode: 1, color: 0xffffff, colorfulImg: '' } });
  assert.equal(item.color, 0x123456);
  assert.equal(entry.blockColor, false);

  sample.stateValues.typeColor = true;
  entry.blockColor = true; entry.color = undefined; entry.colorfulImg = undefined;
  const enabled = sample.rules.read();
  assert.deepEqual(enabled.matchOwned(candidate({ rawMode: 1, color: 0xffffff })), {
    state: 'retain', reason: 'no-native-rule-matched',
    projection: { mode: 1, rawMode: 1, color: undefined, colorfulImg: undefined },
  });
  assert.equal(entry.blockColor, true);
});

test('owned projection bounds top-bottom moves and rejects special overrun, special results, and accessors', () => {
  const sample = fixture();
  sample.stateValues.typeTopBottom = false;
  const snapshot = sample.rules.read();
  const item = candidate({ rawMode: 1 });
  sample.blockStore.dmMap.set('123', modeStackEntry({ modeStack: [
    { mode: 1, rawMode: 1 }, { mode: 4, rawMode: 4 },
  ], index: 0 }));
  assert.deepEqual(snapshot.matchOwned(item), { state: 'retain', reason: 'no-native-rule-matched',
    projection: { mode: 1, rawMode: 1, color: 0, colorfulImg: undefined } });

  sample.stateValues.typeSpecial = false;
  const specialOverrun = sample.rules.read();
  sample.blockStore.dmMap.set('123', modeStackEntry({ modeStack: [
    { mode: 1, rawMode: 1 }, { mode: 2005, rawMode: 2005 },
  ], index: 0 }));
  assert.deepEqual(specialOverrun.matchOwned(item), { state: 'unknown', reason: 'mode-stack-target-unavailable' });

  sample.stateValues.typeTopBottom = true;
  sample.stateValues.typeSpecial = true;
  const ordinary = sample.rules.read();
  sample.blockStore.dmMap.set('123', modeStackEntry({ modeStack: [
    { mode: 1, rawMode: 1 }, { mode: 4, rawMode: 4 },
  ], blockTopBottom: true }));
  assert.deepEqual(ordinary.matchOwned(candidate({ mode: 4, rawMode: 4 })), {
    state: 'retain', reason: 'no-native-rule-matched',
    projection: { mode: 4, rawMode: 4, color: 0, colorfulImg: undefined },
  });
  sample.blockStore.dmMap.set('123', modeStackEntry({ modeStack: [
    { mode: 1, rawMode: 1 }, { mode: 2005, rawMode: 2005 },
  ], index: 0, blockSpecial: true }));
  assert.deepEqual(ordinary.matchOwned(item), { state: 'unknown', reason: 'mode-stack-nonordinary' });

  let getterCalls = 0;
  const history = modeStackEntry({ modeStack: [
    { mode: 1, rawMode: 1 }, { mode: 4, rawMode: 4 },
  ] });
  Object.defineProperty(history, 'blockTopBottom', { get() { getterCalls++; throw Error('history getter'); } });
  sample.blockStore.dmMap.set('123', history);
  assert.deepEqual(ordinary.matchOwned(item), { state: 'unknown', reason: 'mode-stack-state-unavailable' });
  const colorGetter = candidate({ rawMode: 1 });
  Object.defineProperty(colorGetter, 'color', { get() { getterCalls++; throw Error('color getter'); } });
  assert.deepEqual(ordinary.matchOwned(colorGetter), { state: 'unknown', reason: 'mode-stack-state-unavailable' });
  sample.blockStore.dmMap.delete('123');
  assert.deepEqual(ordinary.matchOwned(candidate({ rawMode: 2005 })), {
    state: 'unknown', reason: 'mode-stack-nonordinary',
  });
  assert.equal(getterCalls, 0);
  assert.equal(sample.blockStore.totalFiltleredDm, 0);
  assert.equal(sample.manager.validateCalls, 0);
});

test('malformed stack metadata and accessors fail closed without invoking getters', () => {
  const sample = fixture();
  const item = candidate({ rawMode: 1 });
  const snapshot = sample.rules.read();
  for (const entry of [modeStackEntry({ index: 2 }), modeStackEntry({ modeStack: [{}] }),
    modeStackEntry({ blockColor: undefined })]) {
    sample.blockStore.dmMap.set('123', entry);
    assert.deepEqual(snapshot.match(item), { state: 'unknown', reason: 'mode-stack-state-unavailable' });
  }
  let getterCalls = 0;
  const entry = modeStackEntry();
  Object.defineProperty(entry, 'blockColor', { get() { getterCalls++; return false; } });
  sample.blockStore.dmMap.set('123', entry);
  assert.deepEqual(snapshot.match(item), { state: 'unknown', reason: 'mode-stack-state-unavailable' });
  assert.equal(getterCalls, 0);

  const unreadable = fixture({ invalidObservableField: 'typeColor' });
  unreadable.blockStore.dmMap.set('123', modeStackEntry());
  assert.deepEqual(unreadable.rules.read().match(item), {
    state: 'unknown', reason: 'mode-stack-state-unavailable',
  });
  assert.equal(unreadable.invalidGetterCalls, 0);
});

test('partial user regex remains per-item unknown only while strict native supply owns the gate', () => {
  let strict = false;
  const sample = fixture({ allowPartialUserRules: () => strict });
  sample.blockStore.blockList.push(
    { type: 0, filter: 'blocked', opened: true },
    { type: 1, filter: '/(a+)+$/', opened: true },
    { type: 1, filter: '/a.*b/', opened: true },
  );
  const ordinary = sample.rules.read();
  assert.equal(ordinary.known, false);
  assert.equal(ordinary.reason, 'user-filter-coverage-incomplete');

  strict = true;
  const gated = sample.rules.read();
  assert.equal(gated.known, true);
  assert.deepEqual(gated.match(candidate({ text: 'blocked' })),
    { state: 'exclude', reason: 'native-user-keyword' });
  assert.deepEqual(gated.match(candidate({ text: 'ordinary text' })),
    { state: 'unknown', reason: 'user-rule-coverage-incomplete' });
  assert.deepEqual(gated.match(candidate({ text: 'x'.repeat(1000) })),
    { state: 'unknown', reason: 'user-regexp-work-limit' });
  const row = candidate({ text: 'ordinary text', stime: 14.5 });
  const forecast = forecastBilibiliShadow({ list: [row], currentTime: 10, renderTime: 10,
    lastFetchTime: 10, lastTime: 10.999, preTime: 1, videoSpeed: 1, horizonSeconds: 5,
    area: 100, height: 280, fontSize: 1, limit: 300, match: gated.match });
  assert.deepEqual(forecast.selected[0].reasons, ['user-rule-coverage-incomplete']);
  assert.equal(sample.blockStore.totalFiltleredDm, 0);
  assert.equal(sample.manager.validateCalls, 0);
  strict = false;
  assert.equal(sample.rules.read().known, false, 'ordinary Shadow keeps the old global gate');
});

test('unreviewed state getters remain unknown and are not invoked', () => {
  const sample = fixture({ invalidObservableField: 'dmarea' });
  const snapshot = sample.rules.read();
  assert.equal(snapshot.known, false);
  assert.equal(snapshot.reason, 'native-settings-unavailable');
  assert.deepEqual(snapshot.match(candidate()), { state: 'unknown', reason: 'weight-unavailable' });
  assert.equal(sample.invalidGetterCalls, 0);
  assert.equal(sample.aiLevelGetterCalls, 0);
});
