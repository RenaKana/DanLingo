import test from 'node:test';
import assert from 'node:assert/strict';
import { USER_FILTER_NATIVE_FUNCTIONS, USER_FILTER_NATIVE_CALLBACK } from '../../src/platforms/bilibili/user-filter-contract.ts';
import { BilibiliUserFilterSession } from '../../src/platforms/bilibili/user-filter-session.ts';
import { compileBilibiliUserRules } from '../../src/platforms/bilibili/user-filters.ts';
import {
  createUserFilterReader,
  findUserRuleStore,
  observeUserRuleCalls,
  verifyUserRuleContract,
} from '../../src/platforms/bilibili/user-filter-reader.ts';

const rule = (type, filter, opened = true) => ({ type, filter, opened });
const compile = (rules, options = {}) => compileBilibiliUserRules({
  scope: 'synthetic-document', revision: 1, verified: true, enabled: true, complete: true, rules, ...options,
});
const danmaku = (text, extra = {}) => ({ text, mode: 1, ...extra });

function nativeMethods() {
  return Object.fromEntries(Object.entries(USER_FILTER_NATIVE_FUNCTIONS).map(([name, source]) =>
    [name, Function(`return (${source})`)()]));
}

function readerFixture({ rules = [], status = true, targetDanmaku = {}, userStore = { mid: 42 } } = {}) {
  const dmSettingStore = { state: { status } };
  const blockStore = Object.assign(nativeMethods(), { blockList: rules, dmSettingStore });
  const actualDanmaku = targetDanmaku;
  const store = { danmakuStore: { danmakuX: actualDanmaku }, blockStore, dmSettingStore, userStore };
  actualDanmaku.manager = { config: { fn: { filter: Function('n', `return (${USER_FILTER_NATIVE_CALLBACK})`)(store) } } };
  const root = { rootStore: store };
  return { actualDanmaku, blockStore, dmSettingStore, root, store, roots: () => [root] };
}

test('keywords escape regexp syntax, ignore case, and preserve rule whitespace', () => {
  const compiled = compile([rule(0, 'A+B?'), rule(0, '  Exact   ')]);

  assert.equal(compiled.match(danmaku('lower a+b? text')).state, 'exclude');
  assert.equal(compiled.match(danmaku('lower aab text')).state, 'retain');
  assert.equal(compiled.match(danmaku('exact')).state, 'retain');
  assert.equal(compiled.match(danmaku('prefix  EXACT   suffix')).state, 'exclude');
});

test('regexp rules honor slash flags and keep unflagged patterns case-sensitive', () => {
  const compiled = compile([rule(1, 'Plain'), rule(1, '/Flagged/img')]);

  assert.equal(compiled.match(danmaku('plain')).state, 'retain');
  assert.equal(compiled.match(danmaku('PLAIN')).state, 'retain');
  assert.equal(compiled.match(danmaku('Plain')).state, 'exclude');
  assert.equal(compiled.match(danmaku('flagged')).state, 'exclude');
  assert.equal(compiled.match(danmaku('flagged')).state, 'exclude', 'global regexp lastIndex is reset');
});

test('invalid and nested repetition rules stay unknown, while independent supported rules still reject', () => {
  const partial = compile([rule(0, 'known-hit'), rule(1, '['), rule(1, '^(complex+)+$')]);

  assert.equal(partial.summary.categories.regexp.status, 'partial');
  assert.equal(partial.match(danmaku('known-hit')).state, 'exclude');
  assert.equal(partial.match(danmaku('complex')).state, 'unknown');
  assert.equal(partial.match(danmaku('unrelated')).state, 'unknown');
});

test('sender rules use uhash || uid and ignore dmid and nickname fields', () => {
  const compiled = compile([rule(2, 'target-account')]);

  assert.equal(compiled.match(danmaku('ordinary', {
    uhash: 'other-account', uid: 'target-account', dmid: 'target-account', uname: 'target-account',
  })).state, 'retain');
  assert.equal(compiled.match(danmaku('ordinary', { uhash: '', uid: 'target-account' })).state, 'exclude');
  assert.equal(compiled.match(danmaku('ordinary', {
    uhash: 'other-account', uid: 'other-account', dmid: 'target-account', uname: 'target-account',
  })).state, 'retain');
});

test('border, shooterType 1, and mode 9 are native allow exceptions', () => {
  const compiled = compile([rule(0, 'blocked')]);

  assert.equal(compiled.match(danmaku('blocked', { border: 1 })).state, 'retain');
  assert.equal(compiled.match(danmaku('blocked', { shooterType: 1 })).state, 'retain');
  assert.equal(compiled.match(danmaku('blocked', { mode: 9 })).state, 'retain');
  assert.equal(compiled.match(danmaku('blocked')).state, 'exclude');
});

test('empty, disabled, unverified, and incomplete rule snapshots are conservative', () => {
  const empty = compile([]);
  assert.equal(empty.summary.categories.keyword.status, 'ready');
  assert.equal(empty.summary.categories.account.status, 'unknown');
  assert.equal(empty.match(danmaku('anything')).state, 'retain');

  const disabled = compile([rule(0, 'blocked')], { enabled: false });
  assert.equal(disabled.summary.categories.keyword.status, 'disabled');
  assert.equal(disabled.match(danmaku('blocked')).state, 'retain');

  const failed = compile([rule(0, 'blocked')], { verified: false });
  assert.equal(failed.match(danmaku('blocked')).state, 'unknown');
  const incomplete = compile([rule(0, 'blocked')], { complete: false });
  assert.equal(incomplete.match(danmaku('blocked')).state, 'unknown');
});

test('reader binds only the store owning the exact danmakuX instance', () => {
  const fixture = readerFixture({ rules: [rule(0, 'blocked')] });
  const wrong = readerFixture({ targetDanmaku: {} });

  assert.equal(verifyUserRuleContract(fixture.blockStore), true);
  assert.equal(findUserRuleStore([wrong.root, fixture.root], fixture.actualDanmaku), fixture.store);
  assert.equal(findUserRuleStore([wrong.root], fixture.actualDanmaku), null);

  const reader = createUserFilterReader({ roots: fixture.roots, danmaku: fixture.actualDanmaku,
    documentScope: 'synthetic-document', now: () => 1000 });
  assert.equal(reader.read(true).compiled.match(danmaku('blocked')).state, 'exclude');
  assert.equal(reader.store(), fixture.store);
});

test('reader notices rule edits on the two-second poll and advances the revision', () => {
  let now = 1000;
  const fixture = readerFixture({ rules: [rule(0, 'before')] });
  const reader = createUserFilterReader({ roots: fixture.roots, danmaku: fixture.actualDanmaku,
    documentScope: 'synthetic-document', now: () => now });

  const initial = reader.read();
  assert.equal(initial.changed, true);
  assert.equal(initial.compiled.match(danmaku('before')).state, 'exclude');
  fixture.blockStore.blockList[0].filter = 'after';

  now = 2999;
  const throttled = reader.read();
  assert.equal(throttled.changed, false);
  assert.equal(throttled.compiled.summary.revision, initial.compiled.summary.revision);
  assert.equal(throttled.compiled.match(danmaku('before')).state, 'exclude');

  now = 3000;
  const refreshed = reader.read();
  assert.equal(refreshed.changed, true);
  assert.equal(refreshed.compiled.summary.revision, initial.compiled.summary.revision + 1);
  assert.equal(refreshed.compiled.match(danmaku('before')).state, 'retain');
  assert.equal(refreshed.compiled.match(danmaku('after')).state, 'exclude');
});

test('user-filter heartbeat keeps the detection time stable until the native rule revision changes', () => {
  let now = 1000;
  const nativeSource = danmaku('blocked', { dmid: '1' });
  const fixture = readerFixture({ rules: [rule(0, 'blocked')], targetDanmaku: nativeSource });
  const emitted = [];
  const session = new BilibiliUserFilterSession({ player: fixture.root, danmaku: nativeSource,
    documentScope: 'synthetic-document', now: () => now, emit: message => emitted.push(message) });
  const rows = [{ sourceId: '1', id: 'event-1', platform: 'bilibili', originalText: 'blocked', translatable: true }];

  session.setEnabled(true);
  session.refresh(rows, [nativeSource]);
  const initial = emitted.at(-1);
  assert.equal(initial.revision, 1);
  assert.equal(initial.detectedAt, 1000);

  now = 3100;
  session.refresh(rows, [nativeSource]);
  const heartbeat = emitted.at(-1);
  assert.equal(heartbeat.revision, initial.revision);
  assert.equal(heartbeat.detectedAt, initial.detectedAt, 'an unchanged ruleset retains its original detection time');

  fixture.blockStore.blockList[0].filter = 'changed';
  now = 5200;
  session.refresh(rows, [nativeSource]);
  const changed = emitted.at(-1);
  assert.equal(changed.revision, initial.revision + 1);
  assert.equal(changed.detectedAt, 5200, 'a new ruleset revision records its own detection time');
  assert.ok(session.stop());
});

test('reader drops prior exclusions when a native rule list is only partially readable', () => {
  const fixture = readerFixture({ rules: [rule(0, 'blocked')] });
  const reader = createUserFilterReader({ roots: fixture.roots, danmaku: fixture.actualDanmaku,
    documentScope: 'synthetic-document', now: () => 1000 });
  const initial = reader.read(true);
  assert.equal(initial.compiled.match(danmaku('blocked')).state, 'exclude');

  fixture.blockStore.blockList.push(rule(0, 'x'.repeat(4001)));
  const partial = reader.read(true);
  assert.ok(partial.compiled.summary.revision > initial.compiled.summary.revision);
  assert.equal(partial.compiled.match(danmaku('blocked')).state, 'unknown');
});

test('reader invalidates its last exclusion when root discovery fails', () => {
  const fixture = readerFixture({ rules: [rule(0, 'blocked')] });
  let roots = fixture.roots;
  const reader = createUserFilterReader({ roots: () => roots(), danmaku: fixture.actualDanmaku,
    documentScope: 'synthetic-document', now: () => 1000 });

  const initial = reader.read(true);
  assert.equal(initial.compiled.match(danmaku('blocked')).state, 'exclude');
  roots = () => { throw new Error('synthetic root read failure'); };

  assert.doesNotThrow(() => reader.read(true));
  const failed = reader.read(true);
  assert.equal(failed.compiled.match(danmaku('blocked')).state, 'unknown');
  assert.equal(reader.store(), null);
  assert.ok(failed.compiled.summary.revision > initial.compiled.summary.revision);
});

test('reading and compiling a snapshot never runs the native regexp filter', () => {
  const fixture = readerFixture({ rules: [rule(1, 'never-match')] });
  const reader = createUserFilterReader({ roots: fixture.roots, danmaku: fixture.actualDanmaku,
    documentScope: 'synthetic-document', now: () => 1000 });
  const originalTest = RegExp.prototype.test;
  let nativeTests = 0;
  let readTests = 0;
  let compileTests = 0;
  let result;
  RegExp.prototype.test = function (...args) {
    nativeTests++;
    return originalTest.apply(this, args);
  };
  try {
    const beforeRead = nativeTests;
    result = reader.read(true);
    readTests = nativeTests - beforeRead;
    const beforeCompile = nativeTests;
    compile([rule(1, 'never-match')]);
    compileTests = nativeTests - beforeCompile;
  } finally {
    RegExp.prototype.test = originalTest;
  }
  assert.equal(result.compiled.summary.categories.regexp.supported, 1);
  assert.equal(readTests, compileTests, 'reading adds no native filter execution beyond rule validation');
});

test('observer preserves each natural native return and cleanup restores the original method', () => {
  const originalGlobal = Object.getOwnPropertyDescriptor(globalThis, 'eg');
  globalThis.eg = { yC: { BLOCK_DISABLED: 0, BLOCK_LIST_USER: 11, BLOCK_LIST_KEYWORD: 12, BLOCK_LIST_REGEXP: 13 } };
  let statusReads = 0;
  let lengthReads = 0;
  let shooterReads = 0;
  const state = { get status() { statusReads++; return true; } };
  const setting = { state };
  const blockStore = Object.assign(nativeMethods(), {
    blockList: new Proxy([rule(0, 'needle')], { get(target, key, receiver) {
      if (key === 'length') lengthReads++;
      return Reflect.get(target, key, receiver);
    } }),
    dmSettingStore: setting,
  });
  const original = blockStore.judgeWord;
  const descriptor = Object.getOwnPropertyDescriptor(blockStore, 'judgeWord');
  const calls = [];
  let cleanup;
  let cleanupOwned = false;
  try {
    cleanup = observeUserRuleCalls(blockStore, (source, result) => calls.push({ source, result }));
    assert.equal(verifyUserRuleContract(blockStore), true);
    const matchedSource = danmaku('needle');
    assert.equal(blockStore.judgeWord(matchedSource), 12);

    const disabledSource = { get shooterType() { shooterReads++; return 1; } };
    assert.equal(blockStore.judgeWord(disabledSource), 0);
    assert.deepEqual(calls, [{ source: matchedSource, result: 12 }, { source: disabledSource, result: 0 }]);
    assert.equal(statusReads, 1);
    assert.equal(lengthReads, 2);
    assert.equal(shooterReads, 1);
  } finally {
    cleanupOwned = cleanup?.() ?? false;
    if (originalGlobal) Object.defineProperty(globalThis, 'eg', originalGlobal);
    else delete globalThis.eg;
  }

  assert.equal(cleanupOwned, true);
  assert.equal(blockStore.judgeWord, original);
  assert.deepEqual(Object.getOwnPropertyDescriptor(blockStore, 'judgeWord'), descriptor);
});

test('observer cleanup leaves a later method replacement intact', () => {
  const blockStore = Object.assign(nativeMethods(), { blockList: [], dmSettingStore: { state: { status: false } } });
  const cleanup = observeUserRuleCalls(blockStore, () => {});
  const laterWrapper = function laterWrapper() { return 'later'; };
  blockStore.judgeWord = laterWrapper;

  assert.equal(cleanup(), false);
  assert.equal(blockStore.judgeWord, laterWrapper);
});
