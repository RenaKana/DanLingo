import test from 'node:test';
import assert from 'node:assert/strict';
import { BilibiliNativeSupply, replacementQualification } from '../../src/platforms/bilibili/native-supply.ts';
import { attachBilibiliNative, resolveBilibiliBinding } from '../../src/platforms/bilibili/video.ts';

const href = 'https://www.bilibili.com/video/BV1xx411c7mD/?p=1';
const resourceId = 'av2:cid62131';
const control = { enabled: true, runId: 'run-1', instanceId: 'instance-1', configIdentity: 'config-1',
  sourceLanguage: 'auto', targetLanguage: 'ja', fromMs: 0, toMs: 45000, state: 'running' };

function gateFixture() {
  let mono = 100, wall = 1000, paused = 0;
  const events = [];
  const gate = new BilibiliNativeSupply({ resourceId, session: 'session-1', now: () => mono,
    epochNow: () => wall, emit: event => events.push(event), pause: () => { paused++; } });
  const id = JSON.stringify(['bilibili', resourceId, '1']);
  const source = { id, sourceId: '1', originalText: '中文', mode: 1, canReplace: true, epoch: 0, mediaTimeMs: 4500 };
  const predicted = { epoch: 0, predictionEpoch: 2, ruleRevision: 4, active: true, known: true, items: [{ id, originalText: '中文' }] };
  const ready = { ...source, text: '翻訳', status: 'translated', predictionEpoch: 2, ruleRevision: 4,
    deadlineAtEpochMs: 4000.5, runId: 'run-1', instanceId: 'instance-1', configIdentity: 'config-1' };
  return { gate, id, source, predicted, ready, events, get paused() { return paused; },
    setTime(m, w) { mono = m; wall = w; } };
}

test('strict result binding, deadline and event terminal are separate from shared translation work', () => {
  const f = gateFixture(); f.gate.configure(control); f.gate.updatePrediction(f.predicted);
  assert.equal(f.gate.acceptPrepared({ ...f.ready, status: 'original' }, f.source, 0), false);
  assert.equal(f.gate.acceptPrepared({ ...f.ready, text: '中文' }, f.source, 0), false);
  assert.equal(f.gate.acceptPrepared({ ...f.ready, predictionEpoch: 1 }, f.source, 0), false);
  assert.equal(f.gate.acceptPrepared({ ...f.ready, configIdentity: 'other' }, f.source, 0), false);
  assert.equal(f.gate.acceptPrepared(f.ready, f.source, 0), true);
  assert.deepEqual(f.gate.select(f.source), { choice: 'adopted', reason: 'translated', text: '翻訳', resultId: undefined });
  assert.equal(f.gate.select(f.source).choice, 'duplicate');
  assert.equal(f.gate.acceptPrepared(f.ready, f.source, 0), false, 'late delivery cannot revive a closed display event');
  assert.equal(f.gate.report().counts.adopted, 1);
  assert.equal(f.gate.report().counts.duplicate, 1);
  assert.equal(f.paused, 0);
});

test('planned source mirroring withdraws results without erasing the MAIN-owned prediction', () => {
  const f = gateFixture();
  f.gate.configurePlanned({ enabled: true, configIdentity: control.configIdentity,
    sourceLanguage: control.sourceLanguage, targetLanguage: control.targetLanguage });
  f.gate.updatePrediction(f.predicted);
  f.gate.forget([f.id]);
  assert.equal(f.gate.acceptPrepared(f.ready, f.source, 0), true);
  f.gate.forget([f.id]);
  assert.equal(f.gate.summary().ready, 0);
  assert.equal(f.gate.acceptPrepared({ ...f.ready, ruleRevision: 99 }, f.source, 0), false);
  assert.equal(f.gate.acceptPrepared(f.ready, f.source, 0), true);
  f.gate.invalidate('source-changed');
  assert.equal(f.gate.acceptPrepared(f.ready, f.source, 0), false);
  assert.equal(f.paused, 0);
});

test('invalidations, deadline and no-translation classification remain explicit', () => {
  const f = gateFixture(); f.gate.configure(control); f.gate.updatePrediction(f.predicted);
  f.setTime(101, 4001);
  assert.equal(f.gate.acceptPrepared(f.ready, f.source, 0), false);
  assert.equal(f.gate.select(f.source).reason, 'no-qualified-result');
  f.gate.invalidate('seek');
  assert.equal(f.gate.acceptPrepared(f.ready, f.source, 0), false);
  const emoji = { ...f.source, id: 'emoji', sourceId: '2', originalText: '👍👍' };
  assert.equal(f.gate.select(emoji).choice, 'untranslated-unneeded');
  assert.equal(f.gate.select({ ...emoji, id: 'advanced', mode: 7 }).choice, 'out-of-scope');
  assert.equal(f.gate.report().counts.suppressed, 1);
});

test('a prepared result survives forecast expiry until the actual native gate; new late delivery does not', () => {
  const f = gateFixture(); f.gate.configure(control); f.gate.updatePrediction(f.predicted);
  assert.equal(f.gate.acceptPrepared(f.ready, f.source, 0), true);
  f.setTime(101, 4001);
  f.gate.updatePrediction({ ...f.predicted, items: [] });
  assert.equal(f.gate.acceptPrepared(f.ready, f.source, 0), false, 'forecast expiry does not authorize new delivery');
  assert.equal(f.gate.select(f.source).choice, 'adopted', 'the already prepared result remains valid at actual admission');

  const changed = gateFixture(); changed.gate.configure(control); changed.gate.updatePrediction(changed.predicted);
  assert.equal(changed.gate.acceptPrepared(changed.ready, changed.source, 0), true);
  changed.gate.updatePrediction({ ...changed.predicted, items: [{ id: changed.id, originalText: 'different' }] });
  assert.equal(changed.gate.select(changed.source).reason, 'no-qualified-result');
});

test('fatal contract failure pauses and keeps suppression armed until explicit disable', () => {
  const f = gateFixture(); f.gate.configure(control);
  f.gate.fail('contract-changed');
  assert.equal(f.paused, 1);
  f.gate.configure(control);
  assert.equal(f.gate.state, 'paused');
  assert.equal(f.gate.select(f.source).choice, 'untranslated-needed');
  f.gate.configure(null);
  assert.equal(f.gate.state, 'disabled');
});

test('replacement qualification never enables native insertion and applies a bounded video-time window', () => {
  const input = { enabled: true, currentMediaMs: 10500, scheduledMediaMs: 10000,
    sameResource: true, sameEpoch: true, sameRules: true, correctIdentity: true,
    qualified: true, used: false, reserved: false, nativeAdmitted: true, layoutKnown: true };
  assert.equal(replacementQualification(input).eligible, true);
  // Native stime seconds converted to ms can retain a fractional rounding tail.
  const fractional = { ...input, scheduledMediaMs: 1016.9999999999999 };
  assert.equal(replacementQualification({ ...fractional,
    currentMediaMs: fractional.scheduledMediaMs + 500 }).eligible, true);
  assert.equal(replacementQualification({ ...fractional,
    currentMediaMs: fractional.scheduledMediaMs + 500.001 }).reason, 'expired-event');
  assert.equal(replacementQualification({ ...input, currentMediaMs: 9999 }).reason, 'future-event');
  assert.equal(replacementQualification({ ...input, currentMediaMs: 10501 }).reason, 'expired-event');
  assert.equal(replacementQualification({ ...input, sameRules: false }).eligible, false);
  assert.equal(replacementQualification({ ...input, nativeAdmitted: false }).eligible, false);
  assert.equal(replacementQualification({ ...input, maxLateMs: 1001 }).reason, 'invalid-late-window');
  assert.equal(replacementQualification({ ...input, maxLateMs: 0, currentMediaMs: 10000 }).reason, 'replacement-disabled');
  assert.equal(replacementQualification({ ...input, enabled: false }).reason, 'replacement-disabled');
});

function nativeFixture() {
  let mono = 100, wall = 1000, clearCalls = 0, pauseCalls = 0;
  const posted = [], filtered = [], created = [], hookInputs = [];
  const source = { dmid: '1', text: '中文', stime: 4.5, mode: 1, rawMode: 1, pool: 0,
    uhash: 'author-original', on: false };
  const setting = { visible: true, area: 100, fontSize: 1, limit: 300, preTime: 1 };
  const video = { currentTime: 0, duration: 120, playbackRate: 1, paused: false, seeking: false,
    ended: false, isConnected: true, readyState: 4, played: { length: 1 }, buffered: { length: 0 },
    pause() { pauseCalls++; this.paused = true; }, addEventListener() {}, removeEventListener() {} };
  const manager = { config: { setting }, containerSize: { width: 500, height: 280 },
    container: { ownerDocument: { hidden: false },
      getBoundingClientRect: () => ({ left: 0, right: 500, top: 0, bottom: 280 }) },
    dataBase: { dmArray: [source], timeLine: { list: [source] } },
    lastTime: 0, cDmlist: [], visualArray: [],
    validate() { return true; },
    fetchAndInitDm(render) {
      // The reviewed native fetch moves the cursor before delegating insert;
      // timeController.lastFetchDmTime advances only after insert returns.
      this.lastTime = render + setting.preTime;
      this.insert([source]);
      danmaku.timeController.lastFetchDmTime = render;
    },
    insert(items) {
      danmaku.hooks.beforeRender([], items.slice());
      for (const item of items) {
        filtered.push({ text: item.text, author: item.uhash });
        if (!this.validate(item) || item.on || item.text === 'blocked') continue;
        item.on = true; this.initRender(item);
      }
    },
    initRender(item) {
      const model = { textData: item, text: item.text, firstShow() { return 'shown'; },
        element: { textContent: item.text,
          getBoundingClientRect: () => ({ left: 10, right: 110, top: 20, bottom: 40 }) } };
      created.push(model); this.cDmlist.push(model); return model;
    },
  };
  const danmaku = { manager, config: { setting }, timeController: { renderTime: 0, lastFetchDmTime: 0 },
    isRunning: true, hooks: { beforeRender(_active, pending) { hookInputs.push(pending[0]); } },
    getMetadata: () => ({ version: '1.1.24', lastCompiled: '2026-09-10T15:18:49+08:00' }),
    clear() { clearCalls++; manager.cDmlist.length = 0; manager.visualArray.length = 0; } };
  const player = { getManifest: () => ({ aid: '2', cid: '62131', bvid: 'BV1xx411c7mD', p: 1 }),
    danmaku: { getDanmakuX: () => danmaku }, mediaElement: () => video };
  const binding = resolveBilibiliBinding(player, href);
  assert.ok(binding);
  const attachment = attachBilibiliNative(binding, { now: () => mono, epochNow: () => wall,
    post: value => posted.push(value),
    shadowRules: { read: () => ({ known: true, revision: 4, fingerprint: 'rules-4', reason: null,
      match: () => ({ state: 'retain', reason: 'allowed' }) }) } });
  const content = payload => attachment.onMessage({ data: { bridge: 'danlingo.native.v1', from: 'content',
    session: attachment.session, resourceId, urlResourceId: attachment.identity.urlResourceId, ...payload } });
  const start = () => {
    content({ type: 'control', generation: 0, enabled: true, displayMode: 'translated',
      bilibiliShadowScheduler: true, nativeSupply: control });
    attachment.tick();
  };
  const id = JSON.stringify(['bilibili', resourceId, '1']);
  const sendReady = (overrides = {}) => {
    const shadow = posted.filter(x => x.type === 'bilibili-shadow').at(-1);
    assert.equal(shadow?.known, true);
    assert.ok(shadow.items.some(x => x.id === id));
    content({ type: 'prepared', generation: 0, nativeSupply: true, items: [{ id, sourceId: '1', originalText: source.text,
      text: '翻訳', status: 'translated', epoch: attachment.epoch, predictionEpoch: shadow.predictionEpoch,
      ruleRevision: shadow.ruleRevision, deadlineAtEpochMs: wall + 10000,
      runId: control.runId, instanceId: control.instanceId, configIdentity: control.configIdentity, ...overrides }] });
  };
  return { attachment, manager, source, video, posted, filtered, created, hookInputs, content, start, sendReady,
    get clearCalls() { return clearCalls; }, get pauseCalls() { return pauseCalls; },
    setTime(m, w) { mono = m; wall = w; } };
}

test('native gate adopts a qualified translation after the original hook/filter and before model measurement', t => {
  const f = nativeFixture(); t.after(() => f.attachment.stop()); f.start();
  assert.equal(f.clearCalls, 1);
  f.sendReady();
  f.manager.insert([f.source]);
  assert.deepEqual(f.filtered, [{ text: '中文', author: 'author-original' }]);
  assert.equal(f.hookInputs[0], f.source);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].text, '翻訳');
  assert.equal(f.created[0].textData.dmid, f.source.dmid);
  assert.equal(f.created[0].textData.uhash, 'author-original');
  assert.equal(f.source.text, '中文');
  assert.equal(f.source.on, true);
  f.created[0].textData.on = false;
  assert.equal(f.source.on, false);
  const events = f.posted.filter(x => x.type === 'bilibili-native-supply-event').map(x => x.event.type);
  assert.ok(events.indexOf('nativeAdmissionOpportunity') < events.indexOf('adopted'));
  assert.ok(events.indexOf('adopted') < events.indexOf('nativeInitRender'));
  assert.equal(f.attachment.nativeSupply.report().counts.suppressed, undefined);
  f.content({ type: 'control', generation: 0, enabled: true, displayMode: 'translated',
    bilibiliShadowScheduler: true, nativeSupply: control, nativeSupplyExport: true, shadowExport: true });
  assert.equal(f.posted.findLast(x => x.type === 'bilibili-native-supply-report').report.counts.adopted, 1);
  assert.equal(f.posted.findLast(x => x.type === 'bilibili-shadow-report').report.ledger.classification.eventTypes.nativeInitRender, 1);
});

test('native fetch cursor advance does not withdraw a ready result before the current batch gates', t => {
  const f = nativeFixture(); t.after(() => f.attachment.stop()); f.start(); f.sendReady();
  f.video.currentTime = 4.5; f.setTime(4600, 5500);
  f.manager.fetchAndInitDm(4.5);
  assert.equal(f.manager.lastTime, 5.5);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].text, '翻訳');
  assert.equal(f.attachment.nativeSupply.report().counts.adopted, 1);
  const updates = f.posted.filter(x => x.type === 'bilibili-shadow');
  assert.equal(updates.at(-1).items.some(x => x.id === JSON.stringify(['bilibili', resourceId, '1'])), false,
    'the already consumed batch is absent from the next future forecast');
});

test('prediction-only reference leaves original native admission and identity untouched', t => {
  const f = nativeFixture(); t.after(() => f.attachment.stop());
  f.content({ type: 'control', generation: 0, enabled: false, displayMode: 'original',
    bilibiliShadowScheduler: true, shadowReference: true, nativeSupply: null });
  f.manager.insert([f.source]);
  assert.equal(f.attachment.nativeSupply.active, false);
  assert.equal(f.clearCalls, 0);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].textData.dmid, f.source.dmid);
  assert.equal(f.created[0].text, '中文');
  assert.equal(f.attachment.nativeSupply.report().counts.suppressed, undefined);
});

test('a changed rule lease or playback rate invalidates ready before the native gate', t => {
  const f = nativeFixture(); t.after(() => f.attachment.stop()); f.start(); f.sendReady();
  f.video.playbackRate = 1.25;
  f.manager.insert([f.source]);
  assert.equal(f.created.length, 0);
  assert.equal(f.attachment.nativeSupply.report().counts.adopted, undefined);
  assert.equal(f.attachment.nativeSupply.report().counts.suppressed, 1);
});

test('missing translation suppresses before model creation, releases on, and never retries a closed display event', t => {
  const f = nativeFixture(); t.after(() => f.attachment.stop()); f.start();
  f.content({ type: 'prepared', generation: 0, items: [{ id: JSON.stringify(['bilibili', resourceId, '1']), originalText: '中文', text: '普通译文' }] });
  f.manager.insert([f.source]);
  assert.equal(f.created.length, 0);
  assert.equal(f.source.on, false);
  f.sendReady();
  f.manager.insert([f.source]);
  assert.equal(f.created.length, 0, 'a late qualified result cannot reshow a terminal event');
  assert.deepEqual(f.filtered.map(x => x.text), ['中文', '中文']);
  const report = f.attachment.nativeSupply.report();
  assert.equal(report.counts.nativeAdmissionOpportunity, 2);
  assert.equal(report.counts.suppressed, 1);
  assert.equal(report.counts.duplicate, 1);
  assert.equal(report.counts.nativeInitRender, undefined);
  assert.equal(report.counts.nativeModel, undefined);
  f.content({ type: 'control', generation: 0, enabled: true, displayMode: 'translated',
    bilibiliShadowScheduler: true, nativeSupply: control, shadowExport: true });
  assert.equal(f.posted.findLast(x => x.type === 'bilibili-shadow-report').report.ledger.classification.eventTypes.nativeInitRender ?? 0, 0);
});

test('native keyword rejection happens before supply gate and does not consume translation', t => {
  const f = nativeFixture(); t.after(() => f.attachment.stop()); f.start();
  f.source.text = 'blocked';
  f.manager.insert([f.source]);
  assert.equal(f.created.length, 0);
  assert.equal(f.attachment.nativeSupply.report().counts.nativeAdmissionOpportunity, undefined);
  assert.equal(f.attachment.nativeSupply.report().counts.candidate, 1);
});

test('strict fatal lease pauses playback, suppresses, and never resumes through an unchanged control heartbeat', t => {
  const f = nativeFixture(); t.after(() => f.attachment.stop()); f.start();
  f.setTime(7101, 8000); f.attachment.tick();
  assert.equal(f.pauseCalls, 1);
  f.content({ type: 'control', generation: 0, enabled: true, displayMode: 'translated',
    bilibiliShadowScheduler: true, nativeSupply: control });
  assert.equal(f.attachment.nativeSupply.state, 'paused');
  f.manager.insert([f.source]);
  assert.equal(f.created.length, 0);
  assert.equal(f.source.on, false);
});

test('native model, track, firstShow and DOM geometry are separate observations', t => {
  const f = nativeFixture(); t.after(() => f.attachment.stop()); f.start(); f.sendReady();
  f.manager.insert([f.source]);
  assert.equal(f.attachment.nativeSupply.report().counts.nativeModel, 1);
  assert.equal(f.attachment.nativeSupply.report().counts.trackAccepted, undefined);
  const model = f.manager.cDmlist.pop();
  f.manager.visualArray.push(model);
  f.attachment.tick();
  assert.equal(model.firstShow(), 'shown');
  const report = f.attachment.nativeSupply.report();
  assert.equal(report.counts.trackAccepted, 1);
  assert.equal(report.counts.nativeFirstShow, 1);
  assert.equal(report.counts.domSample, 1);
  const sample = report.events.find(x => x.type === 'domSample');
  assert.equal(sample.text, '翻訳');
  assert.equal(sample.reason, 'geometry-intersects-player');
  assert.equal(sample.nativeResult, true);
});

test('model discarded before visualArray is reported separately from active suppression', t => {
  const f = nativeFixture(); t.after(() => f.attachment.stop()); f.start(); f.sendReady();
  f.manager.insert([f.source]);
  const model = f.manager.cDmlist.pop();
  model.textData.on = false;
  f.attachment.tick();
  const report = f.attachment.nativeSupply.report();
  assert.equal(report.counts.nativeModel, 1);
  assert.equal(report.counts.trackRejected, 1);
  assert.equal(report.counts.suppressed, undefined);
  assert.equal(report.counts.nativeFirstShow, undefined);
});

test('a missing strict control field on a heartbeat pauses instead of switching to original rendering', t => {
  const f = nativeFixture(); t.after(() => f.attachment.stop()); f.start();
  f.content({ type: 'control', generation: 0, enabled: true, displayMode: 'translated',
    bilibiliShadowScheduler: true });
  assert.equal(f.attachment.nativeSupply.state, 'paused');
  assert.equal(f.pauseCalls, 1);
  f.manager.insert([f.source]);
  assert.equal(f.created.length, 0);
});
