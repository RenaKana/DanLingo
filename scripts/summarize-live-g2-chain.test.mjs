import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeG2Condition } from './summarize-live-g2-chain.mjs';

test('window summary separates service settlement, unique tasks, cache, release and concurrency boundaries', () => {
  const row = (id, readyAt, releasedAt, cached) => ({ id, engineTaskId: cached ? undefined : 'shared-task',
    receivedAt: 0, readyAt, releasedAt, cached, validTranslation: true, outputUnicodeChars: 5,
    releaseCallbackCount: 1, releasedTranslated: true });
  const result = summarizeG2Condition({ id: 'test', status: 'COMPLETE_CONTROLLED_CHAIN', bufferMs: 2000, concurrency: 16,
    actualPosts: 3, accountingErrors: [], occurrences: [row('first', 1000, 2000, false),
      row('joined', 2300, 3000, false), row('cached', 2400, 3500, true)],
    attempts: [{ postedAt: 0, settledAt: 1000, status: 'completed' },
      { postedAt: 1999, settledAt: 2500, status: 'timeout' },
      { postedAt: 2000, settledAt: 3000, status: 'completed' }],
    summary: { denominator: 3, onTimeReadyItems: 3, onTimeCoverage: 1, localCacheItems: 1,
      twoSecondBuckets: [], readyTimeBuckets: [{ fromMs: 0, untilMs: 2000 }, { fromMs: 2000, untilMs: 4000 }] } });
  assert.equal(result.timelyProviderTasks, 1);
  assert.equal(result.timelyProviderTaskUnicodeChars, 5, 'shared subscribers must not inflate unique service output');
  assert.deepEqual(result.windows.map(row => [row.readyEvents, row.cachedReadyEvents, row.firstTimelyProviderTasks]),
    [[1, 0, 1], [2, 1, 0]]);
  assert.deepEqual(result.windows.map(row => row.releasedEvents), [0, 3], 'release belongs to its actual later window');
  assert.deepEqual(result.windows.map(row => row.peakActualConcurrency), [1, 2]);
  assert.deepEqual(result.windows.map(row => row.serviceCompletedPosts), [1, 1]);
  assert.deepEqual(result.windows.map(row => row.serviceTimeoutPosts), [0, 1]);
  assert.equal(result.windows[1].serviceCompletedPostLatency.samples, 1);
  assert.equal(result.windows[1].allSettledPostLatencyCensored.samples, 2);
  assert.ok(result.windows.every(row => row.actualPlatformDisplay === null));
});

test('missing tiers remain unexecuted and broken denominator/ready ledgers are rejected', () => {
  assert.deepEqual(summarizeG2Condition({ id: 'c32', status: 'NOT_EXERCISED_GATE', gate: { eligible: false } }),
    { id: 'c32', status: 'NOT_EXERCISED_GATE', gate: { eligible: false } });
  assert.throws(() => summarizeG2Condition({ occurrences: [], summary: { denominator: 1 } }), /denominator/);
  assert.throws(() => summarizeG2Condition({ occurrences: [], summary: { denominator: 0, onTimeReadyItems: 1 } }), /ready ledger/);
});
