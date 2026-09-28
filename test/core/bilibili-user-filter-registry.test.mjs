import test from 'node:test';
import assert from 'node:assert/strict';
import { findRegisteredUserRuleStore, createUserFilterReader } from '../../src/platforms/bilibili/user-filter-reader.ts';
import { USER_FILTER_NATIVE_REGISTRY, USER_FILTER_NATIVE_FUNCTIONS, USER_FILTER_NATIVE_CALLBACK, USER_FILTER_NATIVE_CALLBACK_CURRENT } from '../../src/platforms/bilibili/user-filter-contract.ts';

function fixture() {
  const api = {}, dm = {};
  const root = { api };
  const setting = { state: { status: true } };
  const block = Object.assign(Object.fromEntries(Object.entries(USER_FILTER_NATIVE_FUNCTIONS)
    .map(([key, source]) => [key, Function(`return (${source})`)()])),
  { dmSettingStore: setting, blockList: [{ type: 0, filter: 'blocked', opened: true }] });
  root.rootStore = { rootPlayer: root, danmakuStore: { danmakuX: dm }, blockStore: block,
    dmSettingStore: setting, userStore: { info: { mid: 123 } } };
  dm.manager = { config: { fn: { filter: Function('n', `return (${USER_FILTER_NATIVE_CALLBACK})`)(root.rootStore) } } };
  const active = new Set([root]);
  const registry = { valueOf: Function('tu', 'rO', `return (${USER_FILTER_NATIVE_REGISTRY})`)({ _: value => [...value] }, { Nd: active }) };
  return { api, dm, root, active, registry };
}

test('the audited registry binds public API to its sole adopted rule store without reading other account stores', () => {
  const f = fixture();
  f.active.add({ api: {}, get rootStore() { throw Error('unrelated store must not be inspected'); } });
  assert.equal(findRegisteredUserRuleStore(f.api, f.dm, f.registry), f.root.rootStore);
  const reader = createUserFilterReader({ roots: () => [f.api], registry: () => f.registry,
    danmaku: f.dm, documentScope: 'registry-fixture', now: () => 0 });
  const snapshot = reader.read();
  assert.equal(snapshot.compiled.summary.readEvidence.accountScopeKnown, true);
  assert.equal(snapshot.compiled.match({ text: 'blocked', mode: 1 }).state, 'exclude');
  f.active.delete(f.root);
  assert.equal(reader.read(true).compiled.match({ text: 'blocked', mode: 1 }).state, 'unknown');
});

test('registry discovery rejects an unverified getter, foreign DM instance, and ambiguous roots', () => {
  const f = fixture();
  let called = false;
  assert.equal(findRegisteredUserRuleStore(f.api, f.dm, { valueOf() { called = true; return [f.root]; } }), null);
  assert.equal(called, false);
  assert.equal(findRegisteredUserRuleStore(f.api, {}, f.registry), null);
  const other = { api: f.api };
  other.rootStore = { ...f.root.rootStore, rootPlayer: other };
  f.active.add(other);
  assert.equal(findRegisteredUserRuleStore(f.api, f.dm, f.registry), null);
});

test('the current callback retains rejection and counters, while an altered admission callback stays unknown', () => {
  for (const source of [USER_FILTER_NATIVE_CALLBACK, USER_FILTER_NATIVE_CALLBACK_CURRENT]) {
    for (const blocked of [false, true]) {
      const blockStore = { isBlockDanmaku: () => blocked, dmBlockCount: 0, filterPassCount: 0, blockCountByType: {} };
      const fn = Function('n', `return (${source})`)({ blockStore });
      assert.equal(fn({ mode: 1 }), blocked);
      assert.equal(blockStore.dmBlockCount, blocked ? 1 : 0);
      assert.equal(blockStore.filterPassCount, blocked ? 0 : 1);
      assert.equal(blockStore.blockCountByType.common ?? 0, blocked ? 1 : 0);
    }
  }
  const f = fixture();
  f.dm.manager.config.fn.filter = Function('n', `return (${USER_FILTER_NATIVE_CALLBACK_CURRENT})`)(f.root.rootStore);
  const reader = createUserFilterReader({ roots: () => [f.api], registry: () => f.registry,
    danmaku: f.dm, documentScope: 'current-callback', now: () => 0 });
  assert.equal(reader.read().compiled.match({ text: 'blocked', mode: 1 }).state, 'exclude');
  f.dm.manager.config.fn.filter = () => false;
  assert.equal(reader.read(true).compiled.match({ text: 'blocked', mode: 1 }).state, 'unknown');
});
