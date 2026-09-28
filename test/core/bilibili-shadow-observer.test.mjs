import test from 'node:test';
import assert from 'node:assert/strict';
import { attachPretranslationAudit } from '../../src/diagnostics/bilibili-pretranslation.mjs';

const href = 'https://www.bilibili.com/video/BV1xx411c7mD/';
const identity = { bvid: 'BV1xx411c7mD', aid: '2', cid: '62131', p: 1 };
const source = (dmid = '42', values = {}) => ({ dmid, text: `comment-${dmid}`, stime: 12, mode: 1, weight: 1, border: false, ...values });
const shadow = (readContext, predict = () => ({ decision: 'retain', reason: 'sample-rule', ruleVersion: 'r1' })) => ({ readContext, predict });

function fixture({ pool = [source()], validate = () => false, initRender: nativeInitRender = () => {} } = {}) {
  const events = new Map();
  const video = { currentTime: 10, playbackRate: 1, paused: true, isConnected: true,
    addEventListener(type, callback) { events.set(type, callback); },
    removeEventListener(type, callback) { if (events.get(type) === callback) events.delete(type); },
    emit(type) { events.get(type)?.(); } };
  const manager = { dataBase: { dmArray: pool }, visualArray: [],
    validate(item) { return validate(item); },
    insert(items) { for (const item of items) if (this.validate(item)) this.initRender(item); },
    initRender(item) { return nativeInitRender(item); } };
  const original = { insert: manager.insert, validate: manager.validate, initRender: manager.initRender };
  const player = { danmaku: { getDanmakuX: () => ({ manager, hooks: { beforeRender() {} },
    getMetadata: () => ({ version: '1.1.22', lastCompiled: '2026-07-14T14:26:03+08:00' }) }) },
    mediaElement: () => video, getManifest: () => identity };
  return { manager, video, pool, original, player };
}

const options = extra => ({ timer: false, session: 'shadow-test', ...extra });
const recordFor = (probe, dmid = '42', epoch = 0) => probe.snapshot().records.find(row => row.dmid === dmid && row.epoch === epoch);

test('a valid exclude prediction naturally admitted with on=true is exported before rule-conflict stop', () => {
  let validateCalls = 0, initRenderCalls = 0, probe;
  const f = fixture({
    validate(item) { validateCalls++; item.on = true; return true; },
    initRender() { initRenderCalls++; },
  });
  const conflicts = [];
  probe = attachPretranslationAudit(f.player, href, options({
    shadow: shadow(() => ({ fingerprint: 'settings-a' }), () => ({ decision: 'exclude', reason: 'sample-rule', ruleVersion: 'r1' })),
    onRuleConflict: admission => { conflicts.push(admission); probe.stop('rule-conflict'); },
  }));

  f.manager.insert([f.pool[0]]);

  const snapshot = probe.snapshot(), row = snapshot.records[0], admission = snapshot.admissions[0];
  assert.equal(snapshot.stopped, true);
  assert.equal(snapshot.stopReason, 'rule-conflict');
  assert.equal(validateCalls, 1);
  assert.equal(initRenderCalls, 1, 'the original natural initRender runs once');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].admissionId, admission.admissionId);
  assert.equal(admission.onAtEntry, true);
  assert.equal(admission.shadowPredictionIndex, 0);
  assert.equal(admission.shadowPredictionDecision, 'exclude');
  assert.equal(admission.shadowPredictionValidAtCall, true);
  assert.equal(admission.shadowPredictionValidAtAdmission, true);
  assert.equal(admission.shadowValidationNativeReturn, true);
  assert.equal(admission.shadowRuleConflict, true);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.admissions.length, 1, 'the conflict is not removed from the admission denominator');
  assert.equal(row.initRenderCalls, 1, 'the admitted source remains in the complete record denominator');
  assert.equal(row.initRenderFirst.shadowRuleConflict, true);
  assert.equal(admission.sourceKey, row.key);
  assert.deepEqual({ insert: f.manager.insert, validate: f.manager.validate, initRender: f.manager.initRender }, f.original);
});

test('stale excludes and valid unknown predictions with on=true never trigger rule-conflict stop', () => {
  for (const scenario of [
    { name: 'stale', decision: 'exclude', mutate: item => { item.weight = 2; }, expectedValid: false },
    { name: 'unknown', decision: 'unknown', mutate: () => {}, expectedValid: true },
  ]) {
    let validateCalls = 0, initRenderCalls = 0, conflictCalls = 0;
    const f = fixture({
      validate(item) { validateCalls++; item.on = true; return true; },
      initRender() { initRenderCalls++; },
    });
    const probe = attachPretranslationAudit(f.player, href, options({
      shadow: shadow(() => ({ fingerprint: scenario.name }), () => ({ decision: scenario.decision, reason: scenario.name, ruleVersion: 'r1' })),
      onRuleConflict: () => { conflictCalls++; },
    }));
    scenario.mutate(f.pool[0]);
    f.manager.insert([f.pool[0]]);

    const snapshot = probe.snapshot(), admission = snapshot.admissions[0];
    assert.equal(snapshot.stopped, false, scenario.name);
    assert.equal(conflictCalls, 0, scenario.name);
    assert.equal(validateCalls, 1, scenario.name);
    assert.equal(initRenderCalls, 1, scenario.name);
    assert.equal(admission.onAtEntry, true, scenario.name);
    assert.equal(admission.shadowPredictionDecision, scenario.decision, scenario.name);
    assert.equal(admission.shadowPredictionValidAtCall, scenario.expectedValid, scenario.name);
    assert.equal(admission.shadowPredictionValidAtAdmission, scenario.expectedValid, scenario.name);
    assert.equal(admission.shadowRuleConflict, false, scenario.name);
    assert.equal(snapshot.records[0].initRenderCalls, 1, `${scenario.name} source remains in records`);
    probe.stop();
  }
});

test('prediction samples candidate inputs before native validate and records the pre-call comparison', () => {
  const f = fixture(), sequence = [];
  let probe;
  const originalValidate = f.manager.validate;
  f.manager.validate = function(item) {
    sequence.push('native-validate');
    const row = recordFor(probe);
    assert.equal(row.shadowPredictions[0].invalidatedBy, 'native-input-changed');
    assert.equal(row.validateFirst, null);
    return originalValidate.call(this, item);
  };
  probe = attachPretranslationAudit(f.player, href, options({
    shadow: shadow(() => ({ fingerprint: 'settings-a', aiLevel: 4 }), input => {
      sequence.push(`predict:${input.weight}`);
      return { decision: 'exclude', reason: 'low-weight', ruleVersion: 'weight-v1' };
    }),
  }));
  const initial = recordFor(probe);
  assert.equal(initial.shadowPredictions.length, 1);
  assert.equal(initial.shadowPredictions[0].nativeInput.weight, 1);
  assert.equal(initial.shadowPredictions[0].decision, 'exclude');
  f.pool[0].weight = 3;
  f.manager.insert([f.pool[0]]);
  const row = recordFor(probe);
  assert.deepEqual(sequence, ['predict:1', 'native-validate']);
  assert.equal(row.shadowPredictions[0].invalidatedBy, 'native-input-changed');
  assert.equal(row.validateFirst.nativeInputBeforeCall.weight, 3);
  assert.equal(row.validateFirst.shadowPredictionIndex, 0);
  assert.equal(row.validateFirst.shadowPredictionValidAtCall, false);
  assert.ok(row.shadowPredictions[0].monotonicMs <= row.validateFirst.callStarted.monotonicMs);
  probe.stop();
});

test('valid exclude predictions retain an intermediate native pass conflict between rejected calls', () => {
  const returns = [false, true, false];
  const f = fixture({ validate: () => returns.shift() });
  const probe = attachPretranslationAudit(f.player, href, options({
    shadow: shadow(() => ({ fingerprint: 'settings-a' }), () => ({ decision: 'exclude', reason: 'sample-rule', ruleVersion: 'r1' })),
  }));
  const before = recordFor(probe).shadowPredictions[0];
  for (let i = 0; i < 3; i++) f.manager.insert([f.pool[0]]);
  const row = recordFor(probe), prediction = row.shadowPredictions[0];
  assert.equal(row.validateFirst.nativeReturn, false);
  assert.equal(row.validateLast.nativeReturn, false);
  assert.equal(prediction.decision, 'exclude');
  assert.equal(prediction.monotonicMs, before.monotonicMs);
  assert.equal(prediction.outcomes.validCalls, 3);
  assert.equal(prediction.outcomes.passed, 1);
  assert.equal(prediction.outcomes.rejected, 2);
  assert.equal(prediction.outcomes.unknownReturn, 0);
  assert.equal(prediction.outcomes.firstConflict.nativeReturn, true);
  assert.ok(prediction.outcomes.firstConflict.callStarted);
  assert.ok(prediction.outcomes.firstConflict.callStarted.monotonicMs <= prediction.outcomes.firstConflict.monotonicMs);
  probe.stop();
});

test('active and unreadable native on state never run the shadow rule as if inactive', () => {
  const cases = [
    { label: 'active', expected: 'source-already-active', prepare: item => { item.on = true; } },
    { label: 'accessor', expected: 'source-active-state-unavailable', prepare: (item, count) => {
      Object.defineProperty(item, 'on', { configurable: true, get() { count.reads++; return false; } });
    } },
    { label: 'inherited', expected: 'source-active-state-unavailable', prepare: (item, count) => {
      const prototype = Object.create(Object.getPrototypeOf(item));
      Object.defineProperty(prototype, 'on', { get() { count.reads++; return false; } });
      Object.setPrototypeOf(item, prototype);
    } },
  ];
  for (const scenario of cases) {
    const item = source(), state = { reads: 0, predicts: 0 };
    scenario.prepare(item, state);
    const f = fixture({ pool: [item] });
    const probe = attachPretranslationAudit(f.player, href, options({
      shadow: shadow(() => ({ fingerprint: scenario.label }), () => {
        state.predicts++;
        return { decision: 'retain', reason: 'should-not-run', ruleVersion: 'r1' };
      }),
    }));
    const prediction = recordFor(probe).shadowPredictions[0];
    assert.equal(prediction.decision, 'unknown');
    assert.equal(prediction.reason, scenario.expected);
    assert.equal(state.predicts, 0);
    assert.equal(state.reads, 0);
    probe.stop();
  }
});

test('a candidate first seen after native insert and validate is never backfilled as an early prediction', () => {
  const item = source(), f = fixture({ pool: [] });
  const probe = attachPretranslationAudit(f.player, href, options({
    shadow: shadow(() => ({ fingerprint: 'settings-a' })),
  }));
  f.manager.insert([item]);
  f.pool.push(item);
  probe.sample();
  const row = recordFor(probe);
  assert.ok(row.insertObserved);
  assert.ok(row.validateFirst);
  assert.equal(row.shadowPredictions, undefined);
  probe.stop();
});

test('context fingerprint changes invalidate prior predictions and permit a new revision prediction', () => {
  const f = fixture();
  let value = { fingerprint: 'settings-a', aiLevel: 4 };
  const probe = attachPretranslationAudit(f.player, href, options({
    shadow: shadow(() => value, (_input, context) => ({ decision: context.aiLevel === 4 ? 'retain' : 'unknown',
      reason: 'level-snapshot', ruleVersion: 'weight-v1' })),
  }));
  const before = recordFor(probe).shadowPredictions[0];
  value = { fingerprint: 'settings-b', aiLevel: 2 };
  probe.sample();
  probe.sample();
  const row = recordFor(probe);
  assert.equal(row.shadowPredictions.length, 2);
  assert.equal(row.shadowPredictions[0].decision, 'retain');
  assert.equal(row.shadowPredictions[0].monotonicMs, before.monotonicMs);
  assert.equal(row.shadowPredictions[0].invalidatedBy, 'native-weight-rule-dependency');
  assert.ok(row.shadowPredictions[0].invalidatedAt);
  assert.equal(row.shadowPredictions[1].decision, 'unknown');
  assert.equal(row.shadowPredictions[1].contextFingerprint, 'settings-b');
  assert.ok(row.shadowPredictions[1].contextRevision > row.shadowPredictions[0].contextRevision);
  assert.equal(probe.snapshot().shadow.contexts.length, 2);
  probe.stop();
});

test('same dmid in another playback epoch gets an independent shadow source record', () => {
  const f = fixture();
  const probe = attachPretranslationAudit(f.player, href, options({ shadow: shadow(() => ({ fingerprint: 'same' })) }));
  f.video.emit('seeking');
  const rows = probe.snapshot().records.filter(row => row.dmid === '42');
  assert.deepEqual(rows.map(row => row.epoch), [0, 1]);
  assert.equal(rows[0].shadowPredictions.length, 1);
  assert.equal(rows[1].shadowPredictions.length, 1);
  assert.equal(rows[0].shadowPredictions[0].epoch, 0);
  assert.equal(rows[1].shadowPredictions[0].epoch, 1);
  probe.stop();
});

test('context read failure invalidates predictions; visibility also compares the live source inputs', () => {
  const f = fixture();
  let fail = false;
  const probe = attachPretranslationAudit(f.player, href, options({ shadow: shadow(() => {
    if (fail) throw new Error('temporary read failure');
    return { fingerprint: 'settings-a' };
  }) }));
  const first = recordFor(probe).shadowPredictions[0];
  fail = true;
  probe.observeVisible('42', { monotonicMs: 50, videoTimeMs: 12000 });
  let row = recordFor(probe);
  assert.equal(row.shadowPredictions[0].invalidatedBy, 'native-weight-rule-context-unavailable');
  assert.equal(row.firstVisible.shadowPredictionValidAtVisible, false);
  assert.equal(row.shadowPredictions[0].monotonicMs, first.monotonicMs);
  fail = false;
  probe.sample();
  f.pool[0].weight = 7;
  probe.observeVisible('42', { monotonicMs: 80, videoTimeMs: 12000 });
  row = recordFor(probe);
  assert.equal(row.shadowPredictions[0].invalidatedBy, 'native-weight-rule-context-unavailable');
  assert.equal(row.firstVisible.shadowPredictionValidAtVisible, false);
  assert.ok(probe.snapshot().observationErrors >= 1);
  probe.stop();
});

test('shadow callback failures do not change native returns, throws, or hook restoration', () => {
  const f = fixture({ validate: () => false });
  const probe = attachPretranslationAudit(f.player, href, options({
    shadow: shadow(() => ({ fingerprint: 'settings-a' }), () => { throw new Error('predict-failed'); }),
  }));
  f.manager.insert([f.pool[0]]);
  assert.equal(recordFor(probe).validateFirst.nativeReturn, false);
  assert.equal(probe.snapshot().shadow.enabled, true);
  assert.ok(probe.snapshot().observationErrors >= 1);
  const nativeError = new Error('native-failure');
  f.manager.validate = function() { throw nativeError; };
  assert.throws(() => f.manager.insert([f.pool[0]]), error => error === nativeError);
  probe.stop();
  assert.equal(f.manager.insert, f.original.insert);
  assert.notEqual(f.manager.validate, f.original.validate, 'a later page wrapper must not be overwritten during restore');
  assert.equal(f.manager.initRender, f.original.initRender);
});

test('without a shadow option the original observer shape, native result, and restoration stay unchanged', () => {
  const f = fixture({ validate: () => true });
  const probe = attachPretranslationAudit(f.player, href, options());
  f.manager.insert([f.pool[0]]);
  const row = recordFor(probe);
  assert.equal(row.validateFirst.nativeReturn, true);
  assert.equal(Object.hasOwn(row, 'shadowPredictions'), false);
  assert.equal(Object.hasOwn(row.validateFirst, 'shadowPredictionIndex'), false);
  assert.equal(probe.snapshot().shadow, null);
  probe.stop();
  assert.deepEqual({ insert: f.manager.insert, validate: f.manager.validate, initRender: f.manager.initRender }, f.original);
});
