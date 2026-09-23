import test from 'node:test';
import assert from 'node:assert/strict';
import { auditMediaProgress, auditHiddenScope, recordedPhaseEvidence } from './live-observation-health.mjs';

const rows = points => points.map(([at, time]) => ({ at, playback: { time } }));

test('focused phase uses actual captured snapshot and receipt cohort, never baseline or post-window arrivals', () => {
  const snapshot = { at: 33500, adapterSession: 'current', playback: { contentActive: true } };
  const observed = {
    snapshots: [snapshot, { at: 34000, adapterSession: 'later' }],
    events: [
      { at: 900, adapterSession: 'current', events: [{ sourceId: 'baseline', receivedAt: 900 }] },
      { at: 2000, adapterSession: 'old', events: [{ sourceId: 'old-session', receivedAt: 2000 }] },
      { at: 31000, adapterSession: 'current', events: [
        { sourceId: 'baseline-in-batch', receivedAt: 900 }, { sourceId: 'fresh', receivedAt: 29999 }, { sourceId: 'drain-arrival', receivedAt: 31000 },
      ] },
      { at: 34000, adapterSession: 'current', events: [{ sourceId: 'arrived-after-capture', receivedAt: 2000 }] },
    ],
    renders: [{ at: 999 }, { at: 32000, eventId: 'fresh' }, { at: 34000 }],
  };
  const result = recordedPhaseEvidence(observed, { startAt: 1000, endAt: 31000, observedUntil: 33500 });
  assert.equal(result.snapshot, snapshot, 'reuse the actual recorded object');
  assert.deepEqual(result.batches.flatMap(row => row.events.map(event => event.sourceId)), ['fresh']);
  assert.deepEqual(result.renders, [{ at: 32000, eventId: 'fresh' }]);
  assert.equal(observed.events[2].events.length, 3, 'all raw observations remain intact');
});

test('dwFvfc recorded positions keep advancing across the window boundary and whole sampled drain', () => {
  const samples = rows([[30343, 46821.732511], [31381, 46822.755556], [32396, 46823.770596], [33410, 46824.784350]]);
  const result = auditMediaProgress(samples, { startAt: 30343, observedUntil: 33514 });
  assert.equal(result.healthy, true);
  assert.equal(result.checkedIntervals, 3);
});

test('Ut5dul recorded drain stall is unhealthy even while native flags permit readyState 2', () => {
  const samples = rows([[29373, 3949.162272], [30383, 3950.169909], [31395, 3951.200437], [32423, 3951.928166], [33454, 3951.928166]]);
  const result = auditMediaProgress(samples, { startAt: 29373, observedUntil: 33523 });
  assert.equal(result.healthy, false);
  assert.deepEqual(result.firstFailure, { reason: 'media-not-advancing', index: 4, at: 33454, anchorAt: 32423, elapsedMs: 1031, progressSeconds: 0 });
  assert.equal(samples.length, 5, 'the failed sample remains present');
});

test('a short final boundary read uses a full prior interval and does not invent a stall', () => {
  assert.equal(auditMediaProgress(rows([[0, 100], [1000, 101], [2000, 102], [2020, 102.01]]), { startAt: 0, observedUntil: 2040 }).healthy, true);
});

test('large sampling gaps, missing drain coverage, resets and clock jumps cannot pass', () => {
  for (const [samples, bounds, reason] of [
    [rows([[0, 100], [3000, 103]]), { startAt: 0, observedUntil: 3000 }, 'position-sample-gap'],
    [rows([[0, 100], [1000, 101]]), { startAt: 0, observedUntil: 2000 }, 'missing-drain-end-coverage'],
    [rows([[0, 100], [1000, 0]]), { startAt: 0, observedUntil: 1000 }, 'media-position-reset'],
    [rows([[0, 100], [1000, 200]]), { startAt: 0, observedUntil: 1000 }, 'media-position-jump'],
    [rows([[0, 100], [1000, 100.01]]), { startAt: 0, observedUntil: 1000 }, 'media-not-advancing'],
  ]) {
    const result = auditMediaProgress(samples, bounds);
    assert.equal(result.healthy, false);
    assert.ok(result.failures.some(row => row.reason === reason), reason);
  }
  assert.equal(auditMediaProgress([], { startAt: 0, observedUntil: 1000 }).healthy, false);
});

test('hidden chat and fullscreen containment are required throughout the drain, including restoration', () => {
  const hidden = { chatHidden: true, fullscreenActive: true, fullscreenContainsOverlay: true };
  const samples = [0, 30000, 32000, 33500].map(at => ({ at, scopeState: { ...hidden } }));
  assert.equal(auditHiddenScope(samples, 'fullscreen-chat-closed').healthy, true);
  samples[2].scopeState.chatHidden = false;
  assert.equal(auditHiddenScope(samples, 'chat-closed').firstFailure.at, 32000);
  samples[2].scopeState = { ...hidden, fullscreenContainsOverlay: false };
  assert.equal(auditHiddenScope(samples, 'chat-closed').healthy, true);
  assert.equal(auditHiddenScope(samples, 'fullscreen-chat-closed').healthy, false);
  assert.equal(auditHiddenScope([{ at: 0 }], 'chat-closed').healthy, false);
  assert.equal(auditHiddenScope(samples, 'all').healthy, true, 'all retains its existing scope behavior');
});
