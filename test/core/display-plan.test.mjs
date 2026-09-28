import test from 'node:test';
import assert from 'node:assert/strict';
import { DisplayPlanner } from '../../src/core/display-plan.ts';

const candidate = (sourceId, mediaTimeMs, overrides = {}) => ({
  id: `id-${sourceId}`, sourceId, resourceId: 'video:1', originalText: `text-${sourceId}`,
  mediaTimeMs, inScope: true, needsTranslation: true, state: 'retain', ...overrides,
});
const frame = (candidates = [], overrides = {}) => ({
  resourceId: 'video:1', epoch: 1, mediaTimeMs: 0, wallTimeMs: 100,
  playbackRate: 1, paused: false, seeking: false, contentActive: true,
  commentsVisible: true, durationMs: 60_000, sourceRevision: 1, ruleRevision: 1,
  contextValid: true, complete: true, candidates, ...overrides,
});
const active = snapshot => snapshot.events.filter(row => row.state === 'frozen' && row.epoch === snapshot.epoch);

test('density 1/2/3 uses exact source order, counts original-only events and never refills', () => {
  const rows = [candidate('2', 5300), candidate('10', 5300, { needsTranslation: false }),
    candidate('9007199254740993', 5300, { state: 'unknown' }), candidate('0', 5300, { state: 'exclude' })];
  for (const [limit, expected] of [[1, ['10']], [2, ['10', '2']], [3, ['10', '2', '9007199254740993']]]) {
    const planner = new DisplayPlanner({ limit });
    const first = planner.update(frame(rows));
    assert.deepEqual(active(first).map(row => row.sourceId), expected);
    assert.equal(first.totals.selected, limit);
    assert.equal(first.reasons.userExcluded, 1);
    assert.equal(first.buckets.find(row => row.bucket === 5).selected, limit);
    assert.deepEqual(active(planner.update(frame([...rows].reverse(), { wallTimeMs: 200 }))).map(row => row.sourceId), expected);
    assert.equal(planner.snapshot().totals.selected, limit);
  }
  const unlimited = new DisplayPlanner({ limit: null });
  assert.equal(active(unlimited.update(frame(rows))).length, 3);
});

test('absolute half-open buckets and fractional startup only select future original times', () => {
  const planner = new DisplayPlanner({ limit: 2 });
  const result = planner.update(frame([
    candidate('past', 1500), candidate('edge-left', 1999.9), candidate('edge-right', 2000),
    candidate('next', 2999.9), candidate('future', 9000),
  ], { mediaTimeMs: 1500.5, wallTimeMs: 1234 }));
  assert.deepEqual(active(result).map(row => [row.sourceId, row.bucket, row.startMs]),
    [['edge-left', 1, 1000], ['edge-right', 2, 2000], ['next', 2, 2000]]);
  assert.equal(result.reasons.expired, 1);
  assert.deepEqual(result.drafts.map(row => row.sourceId), ['future']);
  assert.ok(Math.abs(result.events[0].leadMs - 499.4) < 0.001);
  assert.equal(result.events[0].coldStart, true);
  assert.equal(result.events[0].selectedAtMs, 1500.5);
});

test('draft is recomputed without commitment; duplicate messages and order do not affect freeze', () => {
  const rows = [candidate('z', 8100), candidate('a', 8200), candidate('b', 8300)];
  const left = new DisplayPlanner({ limit: 2 }), right = new DisplayPlanner({ limit: 2 });
  const draft = left.update(frame(rows));
  assert.equal(draft.events.length, 0);
  assert.deepEqual(draft.drafts.map(row => row.sourceId), ['z', 'a']);
  assert.equal(left.update(frame([...rows].reverse(), { mediaTimeMs: 3000 })).drafts.length, 0);
  const same = right.update(frame([...rows].reverse().concat(rows[0]), { mediaTimeMs: 3000 }));
  assert.deepEqual(active(left.snapshot()).map(row => row.sourceId), ['z', 'a']);
  assert.deepEqual(active(same).map(row => row.sourceId), ['z', 'a']);
  assert.equal(left.update(frame([candidate('0', 8001), ...rows], { mediaTimeMs: 3100 })).reasons.lateArrival, 1);
  assert.deepEqual(active(left.snapshot()).map(row => row.sourceId), ['z', 'a']);
});

test('revisions, density changes, bucket-width changes and re-enable do not refund an epoch', () => {
  const planner = new DisplayPlanner({ limit: 1 });
  const a = candidate('a', 5100), b = candidate('b', 5200);
  const initial = planner.update(frame([a, b]));
  assert.deepEqual(active(initial).map(row => row.sourceId), ['a']);
  assert.equal(initial.reasons.densityNotSelected, 1);
  let result = planner.update(frame([{ ...a, state: 'exclude' }, b], { ruleRevision: 2 }));
  assert.equal(result.events[0].state, 'revoked');
  assert.equal(result.totals.selected, 1);
  assert.equal(active(result).length, 0);
  assert.equal(result.reasons.densityNotSelected, 1);
  const revision = planner.configure({ limit: 3, bucketMs: 2000 });
  assert.ok(revision.planRevision > initial.planRevision);
  result = planner.update(frame([b, candidate('c', 5600)], { ruleRevision: 2, mediaTimeMs: 100 }));
  assert.equal(active(result).length, 0);
  planner.stop('preview-off');
  assert.equal(planner.update(frame([b], { ruleRevision: 2 })).contextValid, false);
  planner.configure({ limit: 1 });
  assert.equal(active(planner.update(frame([b], { ruleRevision: 2 }))).length, 0);
  assert.equal(planner.snapshot().totals.selected, 1);
});

test('partial rule unknown is labelled, invalid context revokes and stale revisions cannot revive', () => {
  const planner = new DisplayPlanner();
  const unknown = candidate('unknown', 4200, { state: 'unknown' });
  let result = planner.update(frame([unknown, candidate('filtered', 4300, { nativeFiltered: true })]));
  assert.equal(active(result)[0].unknown, true);
  assert.equal(result.reasons.nativeFiltered, 1);
  result = planner.update(frame([unknown], { contextValid: false }));
  assert.equal(result.contextValid, false);
  assert.equal(result.events[0].state, 'revoked');
  assert.equal(active(planner.update(frame([unknown], { contextValid: true }))).length, 0);
  result = planner.update(frame([candidate('new', 7500)], { ruleRevision: 3, mediaTimeMs: 2500 }));
  assert.equal(active(result)[0].sourceId, 'new');
  result = planner.update(frame([candidate('older', 8200)], { ruleRevision: 2, mediaTimeMs: 2500 }));
  assert.equal(result.contextValid, false);
  assert.equal(result.events.find(row => row.sourceId === 'new').state, 'frozen');
  assert.equal(result.reasons.staleRevision, 1);
  assert.equal(active(planner.update(frame([candidate('older', 8200)], { ruleRevision: 4, mediaTimeMs: 2500 }))).length, 0);
});

test('pause does not advance due; 2x changes neither video lead nor missed threshold', () => {
  const planner = new DisplayPlanner({ limit: null, dueGraceMs: 250 });
  const rows = [candidate('due', 5100), candidate('missed', 5300)];
  const selected = planner.update(frame(rows, { mediaTimeMs: 100, playbackRate: 2 }));
  assert.deepEqual(selected.events.map(row => row.leadMs), [5000, 5200]);
  assert.equal(active(planner.update(frame(rows, { mediaTimeMs: 6000, paused: true, playbackRate: 2 }))).length, 2);
  let result = planner.update(frame(rows, { mediaTimeMs: 5200, wallTimeMs: 900, playbackRate: 2 }));
  assert.equal(result.events.find(row => row.sourceId === 'due').state, 'due');
  assert.equal(result.events.find(row => row.sourceId === 'due').dueAtMs, 900);
  result = planner.update(frame(rows, { mediaTimeMs: 6000, wallTimeMs: 1000, playbackRate: 2 }));
  assert.equal(result.events.find(row => row.sourceId === 'missed').state, 'missed');
  assert.equal(result.totals.due, 1);
  assert.equal(result.totals.missed, 1);
  assert.equal(planner.update(frame(rows, { mediaTimeMs: 6000, wallTimeMs: 1100 })).totals.due, 1);
});

test('seek, hidden display, incomplete transactions and end revoke rather than backfill', () => {
  const planner = new DisplayPlanner();
  const row = candidate('same', 4000);
  assert.equal(active(planner.update(frame([row]))).length, 1);
  assert.equal(planner.update(frame([row], { seeking: true })).events[0].state, 'revoked');
  assert.equal(active(planner.update(frame([row]))).length, 0);
  const next = planner.update(frame([row], { epoch: 2, sourceRevision: 2 }));
  assert.equal(active(next).length, 1);
  assert.equal(next.events.find(event => event.epoch === 1).state, 'revoked');
  const stale = planner.update(frame([candidate('old', 4100)], { epoch: 1, sourceRevision: 1 }));
  assert.equal(stale.epoch, 2);
  assert.deepEqual(active(stale).map(event => event.sourceId), ['same']);
  assert.equal(active(planner.update(frame([row], { epoch: 2, sourceRevision: 2, complete: false }))).length, 1);
  assert.equal(active(planner.update(frame([row], { epoch: 2, sourceRevision: 2, commentsVisible: false }))).length, 0);
  const later = candidate('later', 10_000);
  assert.equal(active(planner.update(frame([later], { epoch: 2, sourceRevision: 2 }))).length, 0);
  assert.equal(planner.update(frame([later], { epoch: 2, sourceRevision: 2, mediaTimeMs: 60_000 })).contextValid, false);
});

test('conflicting duplicate identities cannot be selected in either input order', () => {
  const first = candidate('same', 5100), changed = { ...first, originalText: 'different' };
  for (const rows of [[first, changed], [changed, first]]) {
    const snapshot = new DisplayPlanner().update(frame(rows));
    assert.equal(active(snapshot).length, 0);
    assert.equal(snapshot.reasons.conflictingCandidate, 1);
  }
});

test('bounded reporting never evicts the active quota ledger', () => {
  const planner = new DisplayPlanner({ limit: null });
  const rows = Array.from({ length: 4100 }, (_, index) => candidate(String(index), 1000));
  planner.update(frame(rows));
  const result = planner.update(frame(rows, { mediaTimeMs: 2000 }));
  assert.equal(result.totals.selected, 4100);
  assert.equal(result.events.length, 4096);
  assert.equal(result.truncated, true);
  assert.equal(result.truncation.events, 4);
  assert.equal(active(planner.update(frame([candidate('new', 1100)], { mediaTimeMs: 500 }))).length, 0);
});

test('bucket reporting truncation preserves sealed empty buckets', () => {
  const planner = new DisplayPlanner();
  const clock = mediaTimeMs => frame([], { mediaTimeMs, durationMs: 1_000_000 });
  for (let second = 0; second < 520; second++) planner.update(clock(second * 1000));
  const report = planner.snapshot();
  assert.equal(report.buckets.length, 512);
  assert.ok(report.truncation.buckets > 0);
  const old = planner.update(frame([candidate('late', 4500)], { mediaTimeMs: 0, durationMs: 1_000_000 }));
  assert.equal(active(old).length, 0);
  assert.equal(old.reasons.frozenUnclassified, 1);
});

test('invalid window geometry is rejected instead of freezing a partially visible bucket', () => {
  assert.throws(() => new DisplayPlanner({ lookaheadMs: 5000, freezeMs: 5000, bucketMs: 1000 }), RangeError);
});

test('an incomplete source/rule transaction preserves a commitment but still settles its due time', () => {
  const planner = new DisplayPlanner();
  planner.update(frame([candidate('first', 5000), candidate('later', 6000)]));
  let result = planner.update(frame([], { complete: false, sourceRevision: 2, mediaTimeMs: 4900 }));
  assert.equal(result.reasons.incompleteTransaction, 1);
  assert.deepEqual(active(result).map(row => row.sourceId), ['first']);
  assert.equal(result.drafts.length, 0);
  result = planner.update(frame([], { complete: false, sourceRevision: 2, mediaTimeMs: 5100 }));
  assert.equal(result.events[0].state, 'due');
  assert.equal(result.events[0].dueMediaTimeMs, 5100);
  assert.equal(result.totals.selected, 1);
  assert.equal(active(result).length, 0);
  assert.equal(planner.update(frame([candidate('later', 6000)], { sourceRevision: 2, mediaTimeMs: 5100 })).totals.selected, 2);
});

test('per-bucket evidence has a deterministic cap and old sealed buckets remain classified honestly', () => {
  const planner = new DisplayPlanner({ limit: 1 });
  const rows = Array.from({ length: 513 }, (_, index) => candidate(String(index).padStart(4, '0'), 5100));
  const first = planner.update(frame(rows));
  assert.equal(first.buckets.find(row => row.bucket === 5).known, 513);
  assert.equal(first.buckets.find(row => row.bucket === 5).knownTruncated, true);
  assert.equal(first.truncation.knownAtFreeze, 1);
  const later = planner.update(frame([rows[512]]));
  assert.equal(later.reasons.frozenUnclassified, 1);
  assert.equal(later.totals.selected, 1);
});

test('current epoch source ledger has a hard ceiling without forgetting past selections', () => {
  const planner = new DisplayPlanner({ limit: null });
  const rows = Array.from({ length: 50_000 }, (_, index) => candidate(String(index), 5100));
  const first = planner.update(frame(rows));
  assert.equal(first.totals.selected, 50_000);
  assert.equal(first.totals.capacityReached, true);
  const next = planner.update(frame([candidate('new', 11_100)], { mediaTimeMs: 6000 }));
  assert.equal(next.reasons.capacityNotSelected, 1);
  assert.equal(next.totals.selected, 50_000);
  assert.equal(active(next).length, 0);
});

test('a selected source cannot re-enter a later bucket in the same epoch', () => {
  const planner = new DisplayPlanner({ limit: 1 });
  planner.update(frame([candidate('same', 5100)]));
  const moved = candidate('same', 11_100);
  const result = planner.update(frame([moved], { mediaTimeMs: 6000, sourceRevision: 2 }));
  assert.equal(result.events[0].state, 'revoked');
  assert.equal(result.totals.selected, 1);
  assert.equal(active(result).length, 0);
});
