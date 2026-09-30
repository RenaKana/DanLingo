import test from 'node:test';
import assert from 'node:assert/strict';
import { USER_FILTER_NATIVE_CALLBACK, USER_FILTER_NATIVE_CALLBACK_CURRENT,
  USER_FILTER_NATIVE_FUNCTIONS, USER_FILTER_NATIVE_REGISTRY,
  USER_FILTER_NATIVE_FUNCTIONS_121, USER_FILTER_NATIVE_AI_JUDGE_121,
  USER_FILTER_NATIVE_REPORT_FILTER_121, USER_FILTER_NATIVE_REGISTRY_121,
  USER_FILTER_NATIVE_MOBX_GETTER_121, USER_FILTER_NATIVE_CALLBACK_121,
  USER_FILTER_NATIVE_CALLBACK_121_NEWLINE } from '../../src/platforms/bilibili/user-filter-contract.ts';
import { matchNativeRuleContract, matchesNativeRuleCallback, matchesNativeRuleFunction,
  matchesNativeRuleMethods, matchesNativeRuleModeMap, matchesNativeRuleRegistry,
  NATIVE_RULE_CONTRACTS } from '../../src/platforms/bilibili/native-rule-compatibility.ts';
import { observeUserRuleCalls, verifyUserRuleContract } from '../../src/platforms/bilibili/user-filter-reader.ts';
import { createUserFilterReader, findRegisteredUserRuleStore } from '../../src/platforms/bilibili/user-filter-reader.ts';
import { createBilibiliShadowRules } from '../../src/platforms/bilibili/shadow-rules.ts';

const nativeFunction = source => Function(`return (${source})`)();
const methods = Object.fromEntries(Object.entries(USER_FILTER_NATIVE_FUNCTIONS)
  .map(([name, source]) => [name, nativeFunction(source)]));
const readMethod = name => methods[name];

test('the two existing callbacks pair with the exact method group', () => {
  assert.equal(NATIVE_RULE_CONTRACTS.length, 4);
  for (const [index, callback] of [USER_FILTER_NATIVE_CALLBACK, USER_FILTER_NATIVE_CALLBACK_CURRENT].entries()) {
    const match = matchNativeRuleContract(readMethod, nativeFunction(callback));
    assert.equal(match, NATIVE_RULE_CONTRACTS[index]);
    assert.equal(match.callback, callback);
    assert.equal(matchesNativeRuleCallback(nativeFunction(callback)), true);
    assert.equal(matchNativeRuleContract(readMethod, nativeFunction(callback),
      nativeFunction(USER_FILTER_NATIVE_REGISTRY)), match);
    assert.equal(matchNativeRuleContract(readMethod, nativeFunction(callback), () => []), null);
  }
  assert.equal(matchesNativeRuleMethods(readMethod), true);
  assert.equal(matchNativeRuleContract(name => name === 'filterRegexp' ? function() {} : methods[name],
    nativeFunction(USER_FILTER_NATIVE_CALLBACK_CURRENT)), null);
  assert.equal(matchNativeRuleContract(readMethod, function() { return false; }), null);
  assert.equal(matchesNativeRuleCallback(function() { return false; }), false);
});

test('1.1.21 exact controller signatures select two profiles without source normalization', () => {
  assert.equal(USER_FILTER_NATIVE_CALLBACK_121, USER_FILTER_NATIVE_CALLBACK_CURRENT);
  assert.equal(USER_FILTER_NATIVE_CALLBACK_121_NEWLINE.includes('dmBlockCount++\n;var'), true);
  const oldMethods = name => nativeFunction(USER_FILTER_NATIVE_FUNCTIONS[name]);
  const methods121 = name => nativeFunction(USER_FILTER_NATIVE_FUNCTIONS_121[name]);
  for (const [id, callback] of [
    ['core-61de1491-common-callback', USER_FILTER_NATIVE_CALLBACK_121],
    ['core-61de1491-newline-callback', USER_FILTER_NATIVE_CALLBACK_121_NEWLINE],
  ]) {
    const selected = matchNativeRuleContract(methods121, nativeFunction(callback),
      nativeFunction(USER_FILTER_NATIVE_REGISTRY_121));
    assert.equal(selected?.id, id);
    assert.equal(matchesNativeRuleMethods(methods121), true);
    assert.equal(matchesNativeRuleFunction(selected, 'aiJudge', nativeFunction(USER_FILTER_NATIVE_AI_JUDGE_121)), true);
    assert.equal(matchesNativeRuleFunction(selected, 'reportFilterReg', nativeFunction(USER_FILTER_NATIVE_REPORT_FILTER_121)), true);
    assert.equal(matchesNativeRuleFunction(selected, 'mobxStateGetter', nativeFunction(USER_FILTER_NATIVE_MOBX_GETTER_121)), true);
    assert.equal(matchNativeRuleContract(methods121, nativeFunction(callback),
      nativeFunction(USER_FILTER_NATIVE_REGISTRY)), null);
  }
  assert.equal(matchesNativeRuleRegistry(nativeFunction(USER_FILTER_NATIVE_REGISTRY_121)), true);
  assert.equal(matchNativeRuleContract(oldMethods, nativeFunction(USER_FILTER_NATIVE_CALLBACK_121_NEWLINE)), null);
  assert.equal(matchNativeRuleContract(methods121, nativeFunction(USER_FILTER_NATIVE_CALLBACK)), null);
  assert.equal(matchNativeRuleContract(methods121, nativeFunction(USER_FILTER_NATIVE_CALLBACK_121_NEWLINE.replace('\n', ' '))), null);
});

function fixture121({ allowPartialUserRules = () => false, callback = USER_FILTER_NATIVE_CALLBACK_121 } = {}) {
  let now = 1, getterCalls = 0, aiGetterCalls = 0;
  const profile = NATIVE_RULE_CONTRACTS[2];
  const stateValues = { status: true, dmarea: 50, dmdensity: 1, typeScroll: true,
    typeTopBottom: true, typeColor: true, typeSpecial: true, seniorMode: false, preventshade: false };
  const symbol = Symbol('mobx');
  const state = Object.create(null);
  state[symbol] = { getObservablePropValue_(key) { getterCalls++; return stateValues[key]; } };
  for (const key of Object.keys(stateValues)) Object.defineProperty(state, key, {
    configurable: true,
    get: new Function('H', 'e', `return (${USER_FILTER_NATIVE_MOBX_GETTER_121})`)(symbol, key),
  });
  const dmSettingStore = { state };
  Object.defineProperty(dmSettingStore, 'aiLevel', { get() { aiGetterCalls++; throw Error('native accessor must not run'); } });
  const blockStore = {
    ...Object.fromEntries(Object.entries(USER_FILTER_NATIVE_FUNCTIONS_121)
      .map(([name, source]) => [name, nativeFunction(source)])),
    aiJudge: nativeFunction(USER_FILTER_NATIVE_AI_JUDGE_121),
    reportFilterReg: nativeFunction(USER_FILTER_NATIVE_REPORT_FILTER_121),
    blockList: [
      { type: 0, filter: 'alpha', opened: true },
      { type: 2, filter: 'sender-uid', opened: true },
      { type: 1, filter: '/^beta$/i', opened: true },
    ],
    reportFilter: [], dmSettingStore,
    DmBlockMap: Object.fromEntries(Object.entries(profile.blockMap).map(([key, values]) => [key, [...values]])),
    dmMap: new Map(),
  };
  const manager = { config: {
    setting: { visible: true, noDanmakuXTypes: [], limit: 300 }, scene: { isMini: false },
    fn: { filter: nativeFunction(callback) },
  } };
  const danmaku = { manager }, player = {};
  player.rootStore = { rootPlayer: player, danmakuStore: { danmakuX: danmaku }, blockStore, dmSettingStore };
  const rules = createBilibiliShadowRules({ player, danmaku, documentScope: '1.1.21-fixture',
    now: () => now, allowPartialUserRules });
  return { rules, player, danmaku, blockStore, state, stateValues, manager,
    advance: () => { now += 2100; }, get getterCalls() { return getterCalls; },
    get aiGetterCalls() { return aiGetterCalls; } };
}

const candidate121 = (extra = {}) => ({ mode: 1, rawMode: 1, dmid: '123',
  text: 'ordinary', uid: 'other', border: false, weight: 20, pool: 0,
  colorful: false, color: 0, ...extra });

test('1.1.21 common and newline callbacks preserve user rules and profile revisions', () => {
  const f = fixture121();
  const initial = f.rules.read();
  assert.equal(initial.known, true, initial.reason ?? '');
  assert.equal(initial.match(candidate121({ text: 'contains ALPHA' })).reason, 'native-user-keyword');
  assert.equal(initial.match(candidate121({ uid: 'sender-uid' })).reason, 'native-user-sender');
  assert.equal(initial.match(candidate121({ text: 'BETA' })).reason, 'native-user-regexp');
  assert.deepEqual(initial.match(candidate121()), { state: 'retain', reason: 'no-native-rule-matched' });
  assert.ok(f.getterCalls > 0);
  assert.equal(f.aiGetterCalls, 0);
  f.manager.config.fn.filter = nativeFunction(USER_FILTER_NATIVE_CALLBACK_121_NEWLINE);
  f.advance();
  const revised = f.rules.read();
  assert.equal(revised.known, true, revised.reason ?? '');
  assert.ok(revised.revision > initial.revision);
  assert.notEqual(revised.fingerprint, initial.fingerprint);
  assert.equal(revised.match(candidate121({ text: 'BETA' })).reason, 'native-user-regexp');
});

test('1.1.21 mode projection uses reviewed map and remains read-only', () => {
  const f = fixture121();
  f.stateValues.typeTopBottom = false;
  const entry = { modeStack: [{ mode: 1, rawMode: 1 }, { mode: 4, rawMode: 4 }],
    index: 1, blockColor: false, blockSpecial: false, blockTopBottom: false, preventShade: false };
  f.blockStore.dmMap.set('123', entry);
  const item = candidate121({ mode: 4, rawMode: 4 });
  const snapshot = f.rules.read();
  assert.equal(snapshot.known, true, snapshot.reason ?? '');
  assert.equal(snapshot.match(item).reason, 'mode-stack-adjustment');
  assert.deepEqual(snapshot.matchOwned(item), { state: 'retain', reason: 'no-native-rule-matched',
    projection: { mode: 1, rawMode: 1, color: 0, colorfulImg: undefined } });
  assert.equal(item.mode, 4);
  assert.equal(entry.index, 1);
  assert.equal(entry.blockTopBottom, false);
  assert.deepEqual(f.blockStore.DmBlockMap.blockSpecial.includes(3000), true);
  assert.deepEqual(f.blockStore.DmBlockMap.blockColor.includes(2000), true);
});

test('cross-profile methods and callbacks stay unknown even with partial user rules enabled', () => {
  const f = fixture121({ allowPartialUserRules: () => true,
    callback: USER_FILTER_NATIVE_CALLBACK_121_NEWLINE });
  for (const [name, source] of Object.entries(USER_FILTER_NATIVE_FUNCTIONS))
    f.blockStore[name] = nativeFunction(source);
  const mixed = f.rules.read();
  assert.equal(mixed.known, false);
  assert.equal(mixed.reason, 'user-filter-snapshot-unverified');
  assert.deepEqual(mixed.match(candidate121({ text: 'alpha' })),
    { state: 'unknown', reason: 'user-filter-snapshot-unverified' });
  assert.deepEqual(mixed.matchOwned(candidate121({ text: 'alpha' })),
    { state: 'unknown', reason: 'user-filter-snapshot-unverified' });
  f.manager.config.fn.filter = nativeFunction(USER_FILTER_NATIVE_CALLBACK);
  for (const [name, source] of Object.entries(USER_FILTER_NATIVE_FUNCTIONS_121))
    f.blockStore[name] = nativeFunction(source);
  f.advance();
  const reverse = f.rules.read();
  assert.equal(reverse.known, false);
  assert.equal(reverse.reason, 'user-filter-snapshot-unverified');
});

test('1.1.21 unknown rule methods and observable getters remain conservative', () => {
  const report = fixture121();
  report.blockStore.reportFilterReg = function() { throw Error('native method must not run'); };
  const reportSnapshot = report.rules.read();
  assert.equal(reportSnapshot.known, false);
  assert.equal(reportSnapshot.reason, 'report-filter-contract-unverified');
  assert.deepEqual(reportSnapshot.match(candidate121()),
    { state: 'unknown', reason: 'report-filter-contract-unverified' });

  const ai = fixture121();
  ai.blockStore.aiJudge = function() { throw Error('native method must not run'); };
  assert.deepEqual(ai.rules.read().match(candidate121()),
    { state: 'unknown', reason: 'ai-rule-contract-unverified' });

  const state = fixture121();
  let unreviewedReads = 0;
  Object.defineProperty(state.state, 'dmarea', { get() { unreviewedReads++; throw Error('getter must not run'); } });
  const unavailable = state.rules.read();
  assert.equal(unavailable.known, false);
  assert.equal(unavailable.reason, 'native-settings-unavailable');
  assert.equal(unreviewedReads, 0);
  assert.equal(state.aiGetterCalls, 0);
});

test('1.1.21 nano registry binds the same root and cannot pair with another profile', () => {
  const f = fixture121();
  const api = {}, root = { api };
  root.rootStore = { ...f.player.rootStore, rootPlayer: root };
  const roots = new Set([root]);
  const registry = { valueOf: new Function('n', 'si', `return (${USER_FILTER_NATIVE_REGISTRY_121})`)(
    { CR: value => value, ev: (_empty, values) => [...values] }, { $W: roots }) };
  assert.equal(findRegisteredUserRuleStore(api, f.danmaku, registry), root.rootStore);
  const reader = createUserFilterReader({ roots: () => [api], registry: () => registry,
    danmaku: f.danmaku, documentScope: '1.1.21-registry', now: () => 1 });
  assert.equal(reader.read().compiled.match(candidate121({ text: 'alpha' })).state, 'exclude');
  assert.equal(reader.contract()?.id, 'core-61de1491-common-callback');
  registry.valueOf = nativeFunction(USER_FILTER_NATIVE_REGISTRY);
  assert.equal(reader.read(true).compiled.match(candidate121({ text: 'alpha' })).state, 'unknown');
});

test('registry, AI, report, and MobX signatures stay exact and never invoke candidates', () => {
  const contract = NATIVE_RULE_CONTRACTS[0];
  const registry = nativeFunction(USER_FILTER_NATIVE_REGISTRY);
  assert.equal(matchesNativeRuleRegistry(registry), true);
  assert.equal(matchesNativeRuleRegistry(() => []), false);
  for (const name of ['aiJudge', 'reportFilterReg', 'mobxStateGetter']) {
    assert.equal(matchesNativeRuleFunction(contract, name, nativeFunction(contract[name])), true);
    assert.equal(matchesNativeRuleFunction(contract, name, function() { throw Error('must not run'); }), false);
  }
  assert.equal(contract.mobxStateFields.has('status'), true);
  assert.equal(contract.mobxStateFields.has('unreviewedGetter'), false);
});

test('mode map requires the exact reviewed arrays and does not invoke accessors', () => {
  const contract = NATIVE_RULE_CONTRACTS[1];
  const data = (object, key) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && 'value' in descriptor ? { known: true, value: descriptor.value } : { known: false };
  };
  const map = Object.fromEntries(Object.entries(contract.blockMap).map(([key, values]) => [key, [...values]]));
  assert.equal(matchesNativeRuleModeMap(contract, map, data), true);
  map.blockColor = [6];
  assert.equal(matchesNativeRuleModeMap(contract, map, data), false);
  Object.defineProperty(map, 'blockColor', { get() { throw Error('must not read'); } });
  assert.equal(matchesNativeRuleModeMap(contract, map, data), false);
});

test('observer cleanup does not invoke or overwrite a later accessor replacement', () => {
  const store = { ...methods };
  const cleanup = observeUserRuleCalls(store, () => {});
  assert.equal(verifyUserRuleContract(store), true);
  let reads = 0;
  const later = () => { reads++; throw Error('unreviewed getter'); };
  Object.defineProperty(store, 'judgeWord', { configurable: true, get: later });
  assert.equal(cleanup(), false);
  assert.equal(reads, 0);
  assert.equal(Object.getOwnPropertyDescriptor(store, 'judgeWord').get, later);
});
