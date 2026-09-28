import test from 'node:test';
import assert from 'node:assert/strict';
import { BilibiliOfficialObservation } from '../../src/platforms/bilibili/official-observation.ts';
import { OfficialDomObserver } from '../../src/platforms/bilibili/official-dom-observer.ts';

function fixture(t) {
  for (const name of ['start', 'stop']) t.mock.method(OfficialDomObserver.prototype, name, () => {});
  t.mock.method(OfficialDomObserver.prototype, 'snapshot', () => []);
  const setting = { preTime: 1 }, counts = { validate: 0, init: 0, fetch: 0, first: 0 };
  const item = { dmid: '1', text: '原文', stime: 2, mode: 1, on: false };
  const manager = { config: { setting }, cDmlist: [], visualArray: [],
    dataBase: { dmArray: [item], getItemsByRange() { return [item]; } },
    fetchAndInitDm() { counts.fetch++; const preTime = this.config.setting.preTime;
      this.insert(this.dataBase.getItemsByRange(0, preTime)); return 31; },
    insert(items) { for (const i of items) if (this.validate(i)) { i.on = true; this.initRender(i); } },
    validate(i) { counts.validate++; return i.text === '原文'; },
    initRender(i) { counts.init++; this.cDmlist.push({ textData: i, firstShow() { counts.first++; return 17; } }); return 19; },
    collisionCheck() { this.visualArray.push(...this.cDmlist); this.cDmlist = []; return 23; } };
  const originals = Object.fromEntries(['fetchAndInitDm', 'insert', 'validate', 'initRender', 'collisionCheck'].map(k => [k, manager[k]]));
  const timer = { preTime: 1, shouldFetchAndInitDm() { return this.preTime > 0; } };
  const binding = { manager, video: { currentTime: 0, paused: true, playbackRate: 1 }, player: {},
    danmaku: { config: manager.config, timeController: timer, getMetadata: () => ({ version: '1.1.22' }) } };
  return { binding, manager, timer, setting, counts, originals, item };
}

test('official rounds change both runtime windows, delegate originals once and restore ownership', t => {
  for (const seconds of [1, 3, 5]) {
    const f = fixture(t), run = new BilibiliOfficialObservation(f.binding, 'task-1', `native-${seconds}`, () => 2);
    assert.equal(run.start().ready, true);
    assert.equal(f.setting.preTime, seconds); assert.equal(f.timer.preTime, seconds);
    assert.equal(f.manager.fetchAndInitDm(0, 0, null), 31);
    assert.equal(f.manager.collisionCheck(), 23);
    assert.equal(f.manager.visualArray[0].firstShow(), 17);
    assert.deepEqual(f.counts, { fetch: 1, validate: 1, init: 1, first: 1 });
    assert.equal(f.item.text, '原文');
    assert.deepEqual(run.snapshot().events.filter(e => e.type === 'nativeInitRender').map(e => e.dmid), ['1']);
    assert.equal(run.snapshot().events.filter(e => e.type === 'trackAccepted').length, 1);
    run.stop(); assert.equal(run.snapshot().preTime.restored, true);
    assert.equal(f.timer.preTime, 1); assert.equal(f.setting.preTime, 1);
    for (const [k, v] of Object.entries(f.originals)) assert.equal(f.manager[k], v);
  }
});

test('DOM baseline neither changes preTime nor installs native method wrappers or scans pool', t => {
  const f = fixture(t), run = new BilibiliOfficialObservation(f.binding, 'task-dom', 'dom', () => 0);
  assert.equal(run.start().ready, true);
  for (const [k, v] of Object.entries(f.originals)) assert.equal(f.manager[k], v);
  f.manager.fetchAndInitDm();
  assert.deepEqual(run.snapshot().events, []); assert.deepEqual(run.snapshot().sourcePool, []);
  assert.equal(run.snapshot().methodHooks, false); assert.equal(f.setting.preTime, 1);
  run.stop(); assert.equal(run.snapshot().preTime.restored, true);
});

test('changed contracts fail closed and cleanup preserves later settings/method ownership', t => {
  const invalid = fixture(t); invalid.timer.preTime = 2;
  const bad = new BilibiliOfficialObservation(invalid.binding, 'bad', 'native-5', () => 0);
  assert.equal(bad.start().ready, false); assert.equal(invalid.setting.preTime, 1);
  const f = fixture(t), run = new BilibiliOfficialObservation(f.binding, 'owned', 'native-3', () => 0);
  assert.equal(run.start().ready, true);
  const other = () => 44; f.manager.validate = other; f.setting.preTime = 9;
  run.stop();
  assert.equal(f.manager.validate, other); assert.equal(f.setting.preTime, 9);
  assert.equal(run.snapshot().preTime.restored, false); assert.equal(f.timer.preTime, 1);
});
