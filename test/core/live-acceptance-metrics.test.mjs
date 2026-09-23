import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeLiveWindow } from '../../scripts/live-acceptance-metrics.mjs';
const window = { startAt: 100000, endAt: 130000, observedUntil: 134000 };
const sources = Array.from({ length: 20 }, (_, i) => ({ id: `room/session/${i}`, receivedAt: 100000 + i * 1000, eligible: true, sentAtEpochMs: 99900 + i * 1000 }));
const makeOutcomes = n => sources.map((s, i) => ({ id: s.id, at: s.receivedAt + 2005, kind: i < n ? 'translated' : 'original', ...(i < n ? { preparedAt: s.receivedAt + 500 } : {}) }));
const run = patch => summarizeLiveWindow({ providerKind: 'real', bufferMs: 2000, window, sources, outcomes: makeOutcomes(18),
  captureComplete: true, playbackHealthy: true,
  requests: [{ startedAt: 100100, completedAt: 100200, status: 200 }], ...patch });
test('fixed receipt cohort includes original fallback and exactly reaches 90 percent', () => {
  const r = run(); assert.equal(r.counts.denominator, 20); assert.equal(r.translationRate, 0.9);
  assert.equal(r.originalFallbackRate, 0.1); assert.equal(r.target.status, 'MET'); assert.equal(r.latency.extraDisplayDelay.p95Ms, 2005);
});
test('capacity loss and missing outcomes stay in denominator without invented originals', () => {
  const outcomes = makeOutcomes(17).slice(0, 18); outcomes.push({ id: sources[18].id, kind: 'dropped', at: 120000, reason: 'capacity' });
  const r = run({ outcomes }); assert.equal(r.translationRate, 0.85); assert.equal(r.counts.denominator, 20);
  assert.equal(r.counts.originalFallback, 1); assert.equal(r.counts.dropped, 1); assert.equal(r.counts.missingOutcome, 1); assert.equal(r.target.status, 'INCOMPLETE_EVIDENCE');
});
test('same-text events with different scoped IDs remain independent; same ID evidence does not inflate denominator', () => {
  const r = run({ sources: [...sources, sources[0], { ...sources[0], id: 'other-room/session/0' }] });
  assert.equal(r.counts.denominator, 21); assert.equal(r.counts.repeatedSourceRows, 1); assert.equal(r.counts.missingOutcome, 1);
});
test('explicit withdrawal before showing may exclude; deletion after showing cannot erase timeout', () => {
  const outcomes = makeOutcomes(18).slice(0, 19);
  outcomes.push({ id: sources[19].id, kind: 'removed', at: sources[19].receivedAt + 100 });
  outcomes.push({ id: sources[18].id, kind: 'removed', at: sources[18].receivedAt + 3000 });
  const r = run({ outcomes }); assert.equal(r.counts.denominator, 19); assert.equal(r.counts.originalFallback, 1); assert.equal(r.counts.removedBeforeDisplay, 1);
});
test('late prep, duplicate delivery and midflight rewrite invalidate performance acceptance', () => {
  const outcomes = makeOutcomes(20); outcomes[0].preparedAt = sources[0].receivedAt + 2001; outcomes[1].textChangedAfterDisplay = true; outcomes.push({ ...outcomes[2] });
  const r = run({ outcomes }); assert.equal(r.counts.translatedInTime, 19); assert.equal(r.counts.preparedAfterDeadline, 1);
  assert.equal(r.counts.duplicateDeliveries, 1); assert.equal(r.counts.changedAfterDisplay, 1); assert.equal(r.target.status, 'INCOMPLETE_EVIDENCE');
});
test('mock, truncated capture, insufficient samples or undrained windows cannot claim real target', () => {
  assert.equal(run({ providerKind: 'mock' }).target.status, 'NOT_REAL_PROVIDER');
  assert.equal(run({ captureComplete: false }).target.status, 'INCOMPLETE_EVIDENCE');
  assert.equal(run({ captureComplete: undefined }).target.status, 'INCOMPLETE_EVIDENCE');
  assert.equal(run({ playbackHealthy: undefined }).target.status, 'INCOMPLETE_EVIDENCE');
  assert.equal(run({ sources: sources.slice(0, 10) }).target.status, 'INCOMPLETE_EVIDENCE');
  assert.equal(run({ window: { ...window, observedUntil: 131000 } }).target.status, 'INCOMPLETE_EVIDENCE');
  assert.equal(run({ requests: [] }).target.status, 'INCOMPLETE_EVIDENCE');
});
test('non-translatable original events still participate in exactly-once integrity', () => {
  const source = { id: 'emoji', receivedAt: 101000, eligible: false };
  const row = { id: 'emoji', kind: 'original', at: 103000 };
  const r = run({ sources: [...sources, source], outcomes: [...makeOutcomes(18), row, row] });
  assert.equal(r.counts.denominator, 20); assert.equal(r.counts.nonEligible, 1); assert.equal(r.counts.duplicateDeliveries, 1);
  assert.equal(r.target.status, 'INCOMPLETE_EVIDENCE');
});
test('untranslated real samples below goal are NOT_MET, never dropped from the window', () => {
  const r = run({ outcomes: makeOutcomes(17) }); assert.equal(r.target.status, 'NOT_MET'); assert.equal(r.translationRate, 0.85);
});
test('aggregate network and source latency count negative clock evidence separately', () => {
  const r = run({ sources: [{ ...sources[0], sentAtEpochMs: 101000 }, ...sources.slice(1)], requests: [
    { startedAt: 101000, completedAt: 101250, status: 200 }, { startedAt: 102000, completedAt: 102500, status: 429 },
    { startedAt: 103000, completedAt: 102999 }, { startedAt: 104000 }, { startedAt: 99999, completedAt: 100100 } ] });
  assert.equal(r.latency.providerRequest.meanMs, 375); assert.equal(r.requestCounts.started, 4); assert.equal(r.requestCounts.httpErrors, 1);
  assert.equal(r.counts.negativeAcquisitionClockSamples, 1); assert.equal(r.counts.invalidRequestClockSamples, 1); assert.equal(r.latency.messageAcquisition.samples, 19);
});

test('translated flag without actual preparation evidence cannot claim an in-time result', () => {
  const outcomes = makeOutcomes(20).map(({ preparedAt, ...row }) => ({ ...row, at: row.at + 2000 }));
  const r = run({ outcomes }); assert.equal(r.counts.missingPreparationEvidence, 20);
  assert.equal(r.counts.translatedInTime, 0); assert.equal(r.target.status, 'INCOMPLETE_EVIDENCE');
});

test('late or pre-receipt withdrawal cannot hide missing deadline outcomes', () => {
  const extra = Array.from({ length: 10 }, (_, i) => ({ id: `room/session/missing-${i}`, receivedAt: 105000, eligible: true }));
  for (const removedAt of [104999, 107000, 117000]) {
    const r = run({ sources: [...sources, ...extra], outcomes: [...makeOutcomes(18), ...extra.map(s => ({ id: s.id, kind: 'removed', at: removedAt }))] });
    assert.equal(r.counts.denominator, 30); assert.equal(r.counts.missingOutcome, 10);
    assert.equal(r.counts.removedBeforeDisplay, 0); assert.equal(r.translationRate, 0.6); assert.equal(r.target.status, 'INCOMPLETE_EVIDENCE');
  }
});

test('unhealthy playback retains the whole cohort and prevents a successful performance target', () => {
  const r = run({ playbackHealthy: false }); assert.equal(r.counts.denominator, 20);
  assert.equal(r.translationRate, 0.9); assert.equal(r.target.status, 'INCOMPLETE_EVIDENCE');
});

test('impossible preparation before receipt invalidates evidence, display scheduling delay is separate', () => {
  const outcomes = makeOutcomes(20); outcomes[0].preparedAt = sources[0].receivedAt - 1;
  assert.equal(run({ outcomes }).target.status, 'INCOMPLETE_EVIDENCE');
  const delayed = run({ outcomes: makeOutcomes(20).map(o => ({ ...o, at: o.at + 500 })) });
  assert.equal(delayed.target.status, 'MET'); assert.equal(delayed.latency.extraDisplayDelay.p95Ms, 2505);
});
