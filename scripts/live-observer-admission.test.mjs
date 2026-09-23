import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installLiveObserver, observedAdmissionOutcomes } from './live-fixture.mjs';
import { summarizeLiveWindow } from './live-acceptance-metrics.mjs';

const room = 'DlLiveRm001', session = 'session-a';
const eventId = id => JSON.stringify(['youtube', 'live', room, id]);
const cohortId = (id, adapterSession = session) => JSON.stringify([room, adapterSession, id]);

function harness() {
  let mutationCallback, intervalCallback, messageCallback;
  const shadow = { querySelectorAll: () => [], parentElement: null };
  const host = { shadowRoot: shadow };
  const window = { addEventListener(type, callback) { if (type === 'message') messageCallback = callback; } };
  class Element {
    constructor(id, patch = {}) {
      this.tagName = 'SPAN'; this.style = { visibility: 'hidden' }; this.isConnected = false; this.parentNode = null; this.parentElement = null;
      this.textContent = 'fixture text'; this.attrs = { 'data-source-event-id': eventId(id), 'data-translation-status': 'translated', 'data-display-at': '102500', 'data-prepared-at': '101000' };
      this.animations = []; Object.assign(this, patch);
    }
    getAttribute(name) { return this.attrs[name] ?? null; }
    getAnimations() { return this.animations; }
  }
  const sandbox = { window, HTMLElement: Element, URL, location: { href: `https://www.youtube.com/watch?v=${room}` },
    document: { getElementById: id => id === 'danlingo-live-overlay' ? host : null },
    crypto: { randomUUID: () => 'observer-fixture-document' }, performance: { timeOrigin: 100000, now: () => 2500 },
    getComputedStyle: node => ({ visibility: node.style.visibility }),
    setInterval(callback) { intervalCallback = callback; },
    MutationObserver: class { constructor(callback) { mutationCallback = callback; } observe() {} disconnect() {} },
  };
  vm.runInNewContext(`(${installLiveObserver.toString()})()`, sandbox);
  intervalCallback();
  const send = data => messageCallback({ source: window, data: { bridge: 'danlingo-live-v1', from: 'adapter', resourceId: room, adapterSession: session, ...data } });
  const source = (id, adapterSession = session) => {
    send({ type: 'snapshot', adapterSession });
    send({ type: 'events', adapterSession, events: [{ sourceId: id }] });
  };
  const changes = (addedNodes, removedNodes, target = shadow) => ({ type: 'childList', target, addedNodes, removedNodes });
  const rejectBatch = element => [changes([element], []), changes([], [element])];
  return { state: window.__DL_LIVE_EVIDENCE__, source, send, Element, changes, rejectBatch, observe: records => mutationCallback(records) };
}

test('actual observer records one identified hidden temporary span rejected in one shadow mutation callback', () => {
  const h = harness(); h.source('rejected');
  const node = new h.Element('rejected'); h.observe(h.rejectBatch(node));
  assert.equal(h.state.renders.length, 0);
  assert.equal(h.state.admissionRejections.length, 1);
  const row = h.state.admissionRejections[0];
  assert.equal(row.eventId, eventId('rejected')); assert.equal(row.sourceAdapterSession, session);
  assert.equal(row.reason, 'native-overlay-admission'); assert.equal(row.at, 102500);
  assert.equal(row.evidence.sameMutationBatch, true); assert.equal(row.evidence.inlineVisibility, 'hidden');
});

test('normal visible admission followed by animation/resize/paused clear is never rejection', () => {
  const h = harness(); h.source('visible');
  const node = new h.Element('visible', { style: { visibility: 'visible' }, isConnected: true });
  h.observe([h.changes([node], [])]);
  assert.equal(h.state.renders.length, 1);
  node.isConnected = false; node.animations = [];
  h.observe([h.changes([], [node])]);
  assert.equal(h.state.removals.length, 1); assert.equal(h.state.admissionRejections.length, 0);
  // Even if a later unrelated mutation hides a previously rendered node, it is excluded.
  node.style.visibility = 'hidden'; h.observe(h.rejectBatch(node));
  assert.equal(h.state.admissionRejections.length, 0);
});

test('successful visible append-and-clear in one batch is not confused with hidden rejection', () => {
  const h = harness(); h.source('cleared-before-observer');
  h.observe(h.rejectBatch(new h.Element('cleared-before-observer', { style: { visibility: 'visible' } })));
  assert.equal(h.state.admissionRejections.length, 0);
});

test('unknown, animated, connected, nested and separately observed temporary spans remain unclassified', () => {
  const h = harness(); h.source('known');
  h.observe(h.rejectBatch(new h.Element('unknown')));
  h.observe(h.rejectBatch(new h.Element('known', { animations: [{}] })));
  h.observe(h.rejectBatch(new h.Element('known', { isConnected: true })));
  h.observe(h.rejectBatch(new h.Element('known', { tagName: 'DIV' })));
  h.observe(h.rejectBatch(new h.Element('known', { parentNode: {} })));
  const nested = new h.Element('known'), otherTarget = {};
  h.observe([h.changes([nested], [nested], otherTarget)]);
  const separate = new h.Element('known');
  h.observe([h.changes([separate], [])]); h.observe([h.changes([], [separate])]);
  assert.equal(h.state.admissionRejections.length, 0);
});

test('duplicate mutation records/callbacks and repeated same-session identity do not duplicate rejection', () => {
  const h = harness(); h.source('same');
  const node = new h.Element('same'), records = h.rejectBatch(node);
  h.observe([...records, ...records]); h.observe(records); h.observe(h.rejectBatch(new h.Element('same')));
  assert.equal(h.state.admissionRejections.length, 1);
  h.source('same', 'session-b'); h.observe(h.rejectBatch(new h.Element('same')));
  assert.equal(h.state.admissionRejections.length, 2, 'a different known source session is distinct evidence');
});

test('source/snapshot session mismatch cannot assign an old node to the new session', () => {
  const h = harness(); h.source('old'); h.send({ type: 'snapshot', adapterSession: 'session-b' });
  h.observe(h.rejectBatch(new h.Element('old')));
  assert.equal(h.state.admissionRejections.length, 0);
});

test('fixed cohort mapping preserves rejected and missing denominator without borrowing aggregate drop counts', () => {
  const h = harness(); h.source('rejected'); h.observe(h.rejectBatch(new h.Element('rejected')));
  const row = h.state.admissionRejections[0];
  const window = { startAt: 100000, endAt: 130000, observedUntil: 133500 };
  const sources = [
    { id: cohortId('rejected'), receivedAt: 100500, eligible: true },
    { id: cohortId('still-missing'), receivedAt: 100700, eligible: true },
  ];
  const outcomes = observedAdmissionOutcomes([row, row], sources, window);
  assert.deepEqual(outcomes, [{ id: cohortId('rejected'), kind: 'dropped', at: 102500, reason: 'native-overlay-admission' }]);
  const result = summarizeLiveWindow({ providerKind: 'mock', bufferMs: 2000, window, sources, outcomes, captureComplete: true, playbackHealthy: true });
  assert.equal(result.counts.denominator, 2); assert.equal(result.counts.dropped, 1); assert.equal(result.counts.missingOutcome, 1);
  assert.equal(result.counts.translatedInTime, 0); assert.equal(result.counts.originalFallback, 0);
  assert.equal(observedAdmissionOutcomes(undefined, sources, window).length, 0, 'old reports with no exact evidence stay missing');
  for (const invalid of [
    { ...row, at: 100499 }, { ...row, at: 133501 }, { ...row, reason: 'aggregate-drop-49' },
    { ...row, sourceAdapterSession: 'other' }, { ...row, resourceId: 'other-room' },
    { ...row, evidence: { ...row.evidence, animations: 1 } }, { ...row, evidence: undefined },
  ]) assert.equal(observedAdmissionOutcomes([invalid], sources, window).length, 0);
  assert.equal(observedAdmissionOutcomes([row], [{ ...sources[0], receivedAt: 99999 }], window).length, 0);
  assert.equal(observedAdmissionOutcomes([row], [{ ...sources[0], id: cohortId('rejected', 'another-session') }], window).length, 0);
});
