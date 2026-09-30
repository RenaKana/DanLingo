import test from 'node:test';
import assert from 'node:assert/strict';
import { BilibiliShadowSession } from '../../src/platforms/bilibili/shadow-session.ts';
import { REVIEWED_DANMAKU_BUILDS } from '../../src/platforms/bilibili/video.ts';

function fixture(options = {}) {
  let now = 100, nowEpochMs = 100_000, fingerprint = 'stable', ruleRevision = 1;
  const calls = { validate: 0, init: 0, show: 0, fetch: 0 };
  const row = { dmid: '1', text: '原生文本', mode: 1, rawMode: 1, stime: 14.5, pool: 0, on: false };
  const setting = { visible: true, area: 100, fontSize: 1, limit: 300, preTime: 1 };
  const video = { currentTime: 10, paused: false, playbackRate: 1, readyState: 4, seeking: false };
  const manager = { config: { setting }, containerSize: { width: 500, height: 280 },
    container: { ownerDocument: { hidden: false } }, dataBase: { timeLine: { list: [row] } },
    lastTime: 10.999, cDmlist: [], visualArray: [],
    validate(value) { calls.validate++; assert.equal(value, row); return true; },
    initRender(value) { calls.init++; this.cDmlist.push({ textData: value, firstShow() { calls.show++; return 'shown'; } }); return 'created'; },
    fetchAndInitDm() { calls.fetch++; return 'fetched'; } };
  const danmaku = { config: { setting }, manager, isRunning: true,
    timeController: { renderTime: 10, lastFetchDmTime: 10 },
    getMetadata: () => options.metadata ?? ({ version: '1.1.24', lastCompiled: '2026-09-10T15:18:49+08:00' }) };
  const binding = { player: {}, manager, danmaku, video,
    identity: { resourceId: 'av1:cid2', urlResourceId: 'BV1yvhW6sEzi:p1' } };
  const updates = [], original = { ...manager };
  const session = new BilibiliShadowSession({ binding, session: 'fixture', now: () => now,
    nowEpochMs: () => nowEpochMs, observeInit: options.observeInit,
    rules: { read: () => ({ known: true, revision: ruleRevision, fingerprint, reason: null, match: () => ({ state: 'retain', reason: 'allowed' }) }) },
    onUpdate: update => updates.push(update) });
  return { session, updates, calls, row, manager, video, danmaku, original,
    setNow: value => { now = value; }, setEpochNow: value => { nowEpochMs = value; },
    setRule: (key, revision) => { fingerprint = key; ruleRevision = revision; } };
}

test('prediction makes zero native calls, observation delegates once, and stop restores methods', () => {
  const f = fixture(), before = JSON.stringify(f.row);
  f.session.tick();
  assert.deepEqual(f.calls, { validate: 0, init: 0, show: 0, fetch: 0 });
  assert.equal(JSON.stringify(f.row), before);
  assert.equal(f.updates.at(-1).items.length, 1);
  f.setNow(4200); f.video.currentTime = 14.1;
  assert.equal(f.manager.validate(f.row), true);
  assert.equal(f.manager.initRender(f.row), 'created');
  assert.equal(f.manager.cDmlist[0].firstShow(), 'shown');
  const report = f.session.report();
  assert.deepEqual(report.ledger.classification.eventTypes,
    { shadowSelected: 1, nativeValidate: 1, nativeInitRender: 1, nativeFirstShow: 1 });
  assert.equal(report.ledger.overall.leadMs.min, 4100);
  assert.equal(f.calls.init, 1);
  f.session.stop();
  assert.equal(f.manager.validate, f.original.validate);
  assert.equal(f.manager.initRender, f.original.initRender);
  assert.equal(f.manager.fetchAndInitDm, f.original.fetchAndInitDm);
});

test('seek/pause invalidates the outstanding cohort and later wrappers are preserved', () => {
  const f = fixture(); f.session.tick();
  f.video.paused = true; f.setNow(300); f.session.tick(1);
  assert.equal(f.updates.at(-1).known, false);
  assert.equal(f.session.report().ledger.overall.censoredPredictions, 1);
  const installed = f.manager.validate;
  const later = function(...args) { return installed.apply(this, args); };
  f.manager.validate = later;
  const report = f.session.stop();
  assert.equal(f.manager.validate, later);
  assert.equal(report.restoration.laterWrapperPreserved, 1);
  const records = report.ledger.events.length;
  f.manager.validate(f.row);
  assert.equal(f.session.report().ledger.events.length, records);
});

test('effective subscriptions carry an epoch-clock deadline and do not retain historical selections', () => {
  const f = fixture(); f.session.tick();
  const first = f.updates.at(-1);
  assert.equal(first.predictionEpoch, 0);
  assert.equal(first.ruleRevision, 1);
  assert.equal(first.sampledAtEpochMs, 100_000);
  assert.equal(first.playbackRate, 1);
  assert.equal(first.items[0].sourceId, '1');
  assert.equal(first.items[0].stimeMs, 14_500);
  assert.ok(first.items[0].deadlineAtEpochMs > first.sampledAtEpochMs);
  assert.deepEqual(first.items[0].reasons, []);

  f.video.currentTime = 16.5; f.setEpochNow(106_500); f.session.tick();
  assert.deepEqual(f.updates.at(-1).items, [], 'prior ledger selection is no longer a live subscription');
  assert.equal(f.session.report().ledger.classification.eventTypes.shadowSelected, 1);
  f.setRule('new-rules', 2); f.session.tick();
  assert.equal(f.updates.at(-1).ruleRevision, 2);
  assert.equal(f.updates.at(-1).predictionEpoch, 1);
  f.session.stop();
});

test('Shadow admits exactly the adapter-reviewed 1.1.21, 1.1.22 and 1.1.24 signatures and exports actual metadata', () => {
  assert.deepEqual(REVIEWED_DANMAKU_BUILDS.map(row => [row.version, row.lastCompiled]), [
    ['1.1.24', '2026-09-10T15:18:49+08:00'],
    ['1.1.22', '2026-07-14T14:26:03+08:00'],
    ['1.1.21', '2026-04-09T15:46:43+08:00'],
  ]);
  for (const metadata of REVIEWED_DANMAKU_BUILDS) {
    const f = fixture({ metadata }); f.session.tick();
    assert.equal(f.session.report().known, true);
    assert.deepEqual(f.session.report().metadata, metadata);
    assert.equal(f.updates.at(-1).items.length, 1);
    f.session.stop();
  }
  const unsupported = fixture({ metadata: { version: '1.1.22', lastCompiled: 'changed-build' } });
  unsupported.session.tick();
  assert.equal(unsupported.session.report().known, false);
  assert.equal(unsupported.session.report().reason, 'native-version-unreviewed');
  assert.deepEqual(unsupported.session.report().metadata,
    { version: '1.1.22', lastCompiled: 'changed-build' });
  assert.deepEqual(unsupported.updates.at(-1).items, []);
  unsupported.session.stop();
});

test('one prediction epoch freezes the first deadline, expiry drops demand, and rule change gets a fresh deadline', () => {
  const f = fixture(), setting = f.danmaku.timeController;
  f.session.tick();
  const first = f.updates.at(-1);
  assert.equal(first.items.length, 1);
  f.video.currentTime = 10.1; setting.renderTime = 10.1; f.setEpochNow(100_300); f.session.tick();
  const jittered = f.updates.at(-1);
  assert.equal(jittered.predictionEpoch, first.predictionEpoch);
  assert.equal(jittered.items.length, 1);
  assert.equal(jittered.items[0].deadlineAtEpochMs, first.items[0].deadlineAtEpochMs);
  f.setEpochNow(first.items[0].deadlineAtEpochMs + 1); f.session.tick();
  assert.deepEqual(f.updates.at(-1).items, [], 'expired frozen demand cannot regain time');
  f.setRule('changed-rules', 2); f.session.tick();
  const changed = f.updates.at(-1);
  assert.equal(changed.predictionEpoch, first.predictionEpoch + 1);
  assert.equal(changed.items.length, 1);
  assert.ok(changed.items[0].deadlineAtEpochMs > first.items[0].deadlineAtEpochMs);
  f.session.stop();
});

test('an expired frozen prediction does not invalidate another live item in the same update', () => {
  const f = fixture();
  f.manager.dataBase.timeLine.list.unshift({ ...f.row, dmid: '2', text: '第二条', stime: 13.5 });
  f.session.tick();
  const first = f.updates.at(-1);
  assert.equal(first.items.length, 2);
  const ordered = [...first.items].sort((a, b) => a.deadlineAtEpochMs - b.deadlineAtEpochMs);
  assert.ok(ordered[1].deadlineAtEpochMs > ordered[0].deadlineAtEpochMs);
  f.setEpochNow(ordered[0].deadlineAtEpochMs + 1); f.session.tick();
  const update = f.updates.at(-1);
  assert.equal(update.known, true);
  assert.deepEqual(update.items.map(item => item.id), [ordered[1].id]);
  assert.ok(update.items[0].deadlineAtEpochMs > update.sampledAtEpochMs);
  f.session.stop();
});

test('adapter-owned init observation records only the actual delegate and retains firstShow tracking', () => {
  const f = fixture({ observeInit: false });
  f.session.tick();
  assert.equal(f.session.report().known, true);
  assert.equal(f.manager.initRender, f.original.initRender);
  f.session.recordNativeInit(f.row);
  assert.equal(f.manager.initRender(f.row), 'created');
  f.session.afterNativeInit();
  f.manager.cDmlist[0].firstShow();
  assert.deepEqual(f.session.report().ledger.classification.eventTypes,
    { shadowSelected: 1, nativeValidate: 0, nativeInitRender: 1, nativeFirstShow: 1 });
  f.session.stop();
});
