import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createLedger,
  getLedgerUsage,
  loadLedger,
  reserveSegment,
  settleSegment,
  validateLedger,
  writeJSON,
} from './bilibili-dispatch-ledger.mjs';

function reserve(ledger, group, reason) {
  return reserveSegment(ledger, { group, buildId: 'build-0.4.14-test', configFingerprint: 'cfg-fingerprint', ...(reason ? { reason } : {}) });
}

function settle(ledger, segment, values = {}) {
  return settleSegment(ledger, segment.id, { status: 'completed', providerCalls: 1, sentInputItems: 1, sentInputChars: 12, cancelled: 0, ...values });
}

test('a persisted reservation remains charged after a crash and blocks another start', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'danlingo-ledger-crash-'));
  try {
    const filePath = path.join(directory, 'dispatch-ledger.json');
    const { ledger, segment } = reserve(createLedger(), 'B');
    assert.deepEqual(segment.actual, { providerCalls: null, sentInputItems: null, sentInputChars: null, cancelled: null });
    await writeJSON(filePath, ledger);

    const afterRestart = await loadLedger(filePath);
    assert.equal(getLedgerUsage(afterRestart).providerCalls, 55);
    assert.equal(getLedgerUsage(afterRestart).pendingReservedProviderCalls, 55);
    assert.throws(() => reserve(afterRestart, 'A'), /current ledger state/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the base order is B then A and settled actuals release unused reserved calls', () => {
  assert.throws(() => reserve(createLedger(), 'A'), /next required group is B/);

  let { ledger, segment: b } = reserve(createLedger(), 'B');
  assert.throws(() => reserve(ledger, 'B'), /current ledger state/);
  ({ ledger } = settle(ledger, b, { providerCalls: 8, sentInputItems: 8, sentInputChars: 120 }));
  assert.equal(getLedgerUsage(ledger).providerCalls, 8);

  const reservedA = reserve(ledger, 'A');
  assert.equal(reservedA.segment.group, 'A');
  assert.equal(getLedgerUsage(reservedA.ledger).providerCalls, 63);
  ({ ledger } = settle(reservedA.ledger, reservedA.segment, { providerCalls: 9, sentInputItems: 9, sentInputChars: 130 }));
  assert.equal(getLedgerUsage(ledger).providerCalls, 17);
  assert.throws(() => reserve(ledger, 'B'), /current ledger state/);
});

test('only environment-invalid evidence enables at most two retries, with unknown usage charged as 55', () => {
  let { ledger, segment: b1 } = reserve(createLedger(), 'B');
  ({ ledger } = settle(ledger, b1, { status: 'environment-invalid', reason: 'Playback mode changed during the measured interval', providerCalls: null }));
  assert.equal(getLedgerUsage(ledger).providerCalls, 55);
  assert.throws(() => reserve(ledger, 'A'), /next required group is B/);
  assert.throws(() => reserve(ledger, 'B', 'poor-results'), /environmental recovery reason/);

  let next = reserve(ledger, 'B', 'playback-state-changed');
  ({ ledger } = settle(next.ledger, next.segment, { providerCalls: 55, sentInputItems: 55, sentInputChars: 600 }));
  next = reserve(ledger, 'A');
  ({ ledger } = settle(next.ledger, next.segment, { status: 'environment-invalid', reason: 'Temporary connection broke during collection', providerCalls: null }));
  next = reserve(ledger, 'A', 'temporary-connection');
  ({ ledger } = settle(next.ledger, next.segment, { providerCalls: 55, sentInputItems: 55, sentInputChars: 600 }));

  assert.equal(getLedgerUsage(ledger).formalStarts, 4);
  assert.equal(getLedgerUsage(ledger).recoveryStarts, 2);
  assert.equal(getLedgerUsage(ledger).providerCalls, 220);
  assert.equal(getLedgerUsage(ledger).remainingProviderCalls, 0);
  assert.throws(() => reserve(ledger, 'A', 'runtime-state-changed'), /current ledger state|four-start budget/);
  assert.equal(validateLedger(ledger), ledger);
});

test('settlement enforces per-segment limits, records cancellation counts, and rejects duplicate IDs', () => {
  let { ledger, segment } = reserve(createLedger(), 'B');
  for (const invalid of [
    { providerCalls: 56 },
    { sentInputItems: 56 },
    { sentInputChars: 601 },
    { providerCalls: 1, cancelled: 2 },
  ]) {
    assert.throws(() => settle(ledger, segment, invalid));
  }

  ({ ledger } = settle(ledger, segment, { providerCalls: 4, sentInputItems: 4, sentInputChars: 50, cancelled: 2 }));
  assert.equal(ledger.segments[0].actual.cancelled, 2);
  assert.throws(() => settle(ledger, segment, { providerCalls: 4 }), /already been settled/);
  assert.throws(() => settleSegment(ledger, 'segment-99', { status: 'completed' }), /Unknown segment id/);

  const hardReservation = reserve(createLedger(), 'B');
  const hardFailure = settle(hardReservation.ledger, hardReservation.segment, {
    status: 'hard-failure', reason: 'Configuration fingerprint changed',
  });
  assert.throws(() => reserve(hardFailure.ledger, 'A'), /current ledger state/);
});

test('atomic JSON writes replace the file and loader rejects unsupported schemas', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'danlingo-ledger-atomic-'));
  try {
    const filePath = path.join(directory, 'dispatch-ledger.json');
    const first = createLedger();
    await writeJSON(filePath, first);
    const { ledger } = reserve(first, 'B');
    await writeJSON(filePath, ledger);
    assert.deepEqual(await loadLedger(filePath), ledger);
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).segments.length, 1);

    await writeJSON(filePath, { ...ledger, version: 99 });
    await assert.rejects(loadLedger(filePath), /unsupported schema or version/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
