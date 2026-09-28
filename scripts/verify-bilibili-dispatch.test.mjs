import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySegment, consumeCommandResult } from './verify-bilibili-dispatch.mjs';

test('a late issued response keeps the queued stop available without accepting unknown or duplicate results', () => {
  let stopped = false;
  const pending = new Map([['stop', { resolve: () => { stopped = true; }, reject: () => {} }]]);
  const late = new Map([['start', 200]]);
  assert.equal(consumeCommandResult({ id: 'start', ok: true }, pending, late, 100), 'late');
  assert.equal(pending.has('stop'), true);
  assert.throws(() => consumeCommandResult({ id: 'start', ok: true }, pending, late, 100), /unknown-command/);
  assert.throws(() => consumeCommandResult({ id: 'foreign', ok: true }, pending, late, 100), /unknown-command/);
  consumeCommandResult({ id: 'stop', ok: true }, pending, late, 100);
  assert.equal(stopped, true);
});

function capture(overrides = {}) {
  return { localExperiment: { report: {}, dispatch: {
    singleDispatch: true, concurrency: 2, peakRequests: 0, rawPacketSizes: {},
  } }, ended: { reason: 'playback-start-failed' },
  runnerEvidence: { environment: { status: 'stable' } }, ...overrides };
}
test('zero-packet playback failure preserves environmental recovery', () => {
  assert.equal(classifySegment({ group: 'B' }, capture()).status, 'environment-invalid');
});
test('a normal endpoint cannot prove an entirely unobserved dispatch policy', () => {
  const result = classifySegment({ group: 'B' }, capture({ ended: { reason: 'interval-complete' } }));
  assert.equal(result.status, 'hard-failure');
  assert.equal(result.reason, 'dispatch-policy-unobserved');
});
test('actual B policy violation is a hard stop even during an environmental failure', () => {
  const raw = capture(); raw.localExperiment.dispatch.rawPacketSizes = { 2: 1 };
  assert.equal(classifySegment({ group: 'B' }, raw).status, 'hard-failure');
});
test('actual packets require stable normal completion', () => {
  const raw = capture({ ended: { reason: 'interval-complete' } });
  raw.localExperiment.dispatch.rawPacketSizes = { 1: 20 };
  raw.localExperiment.dispatch.peakRequests = 2;
  assert.equal(classifySegment({ group: 'B' }, raw).status, 'completed');
  raw.runnerEvidence.environment.status = 'unknown';
  assert.equal(classifySegment({ group: 'B' }, raw).status, 'environment-invalid');
});
test('native contract or persistent-write changes never qualify for environmental retry', () => {
  const raw = capture();
  raw.runnerEvidence.environment = { status: 'changed', changes: [{ field: 'native' }] };
  assert.equal(classifySegment({ group: 'B' }, raw).status, 'hard-failure');
  raw.runnerEvidence.environment = { status: 'stable' };
  raw.localExperiment.report.safety = { savedSettingsWrites: 0, persistentCacheWrites: 1, modelLoads: 0 };
  assert.equal(classifySegment({ group: 'B' }, raw).status, 'hard-failure');
});
