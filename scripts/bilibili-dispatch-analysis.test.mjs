import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeRun, compare } from './bilibili-dispatch-analysis.mjs';

const sourceId = dmid => JSON.stringify(['bilibili', 'resource-r', dmid]);
const source = (dmid, originalText, flags = {}) => ({ id: sourceId(dmid), originalText, mediaTimeMs: 1500,
  translatable: true, needsTranslation: true, textAllowed: true, ...flags });
const record = (dmid, at, flags = {}) => ({ cid: 'cid-1', dmid, plannedVideoTimeMs: 1500, initRenderCalls: 1,
  initRenderFirst: { onAtEntry: true, monotonicMs: at, videoTimeMs: 1500, playbackRate: 1 }, ...flags });

function rawRun({ single = false, records = [], cacheRows = [], watchEvents = [], visibleEvents = [],
  environment = { status: 'stable', signature: { viewport: [1280, 800], player: [10, 10, 800, 450] }, changes: [] },
  startedAt = null, extra = {} } = {}) {
  return {
    schema: 2,
    identity: { resourceId: 'resource-r', cid: 'cid-1' },
    currentSettings: { modelFingerprint: 'model-1', targetLanguage: 'ja', promptHash: 'prompt-1' },
    shadowContract: { sha256: 'rule-hash-1' },
    playingStart: { monotonicMs: 50, videoTimeMs: 1000, playbackRate: 1 },
    ended: { monotonicMs: 250, videoTimeMs: 2000, reason: 'interval-complete' },
    cacheRows,
    records,
    visibleEvents,
    runnerEvidence: { environment, buildId: 'build-1', modelFingerprint: 'model-1',
      ...(startedAt ? { startedAt } : {}) },
    localExperiment: {
      configuration: { runId: single ? 'run-b' : 'run-a', dispatchComparison: true, singleDispatch: single, filterEnabled: true,
        fromMs: 1000, toMs: 2000, prefetchSeconds: 5, playbackRate: 1,
        batchSize: single ? 1 : 20, engineConcurrency: 2, budget: { maxInputItems: 55, maxInputChars: 600 } },
      watchEvents,
      report: { runId: single ? 'run-b' : 'run-a', resourceId: 'resource-r', providerAttempts: [],
        safety: { modelGeneration: 'gen-1', runtimeParallel: 2 } },
    },
    ...extra,
  };
}

function comparablePair() {
  const shared = source('shared', 'same-source'), extra = source('extra', 'extra-source');
  return {
    a: rawRun({ single: false, startedAt: '2026-09-26T10:05:00Z', records: [record('shared', 100)],
      cacheRows: [shared, extra], watchEvents: [{ event: 'request-start', requestId: 'a-1', atMs: 80,
        items: [{ id: shared.id, text: shared.originalText }, { id: extra.id, text: extra.originalText }] },
        { event: 'prepared', atMs: 90, items: [{ id: shared.id, originalText: shared.originalText, text: 'same-translation' }] }] }),
    b: rawRun({ single: true, startedAt: '2026-09-26T10:00:00Z', records: [record('shared', 100)],
      cacheRows: [shared], watchEvents: [{ event: 'request-start', requestId: 'b-1', atMs: 70,
        items: [{ id: shared.id, text: shared.originalText }] }] }),
  };
}

test('analyzeRun retains the natural eligible denominator, cached rows, mapping unknowns, and direct selection evidence', () => {
  const input = rawRun({
    records: [
      record('early', 100, { initRenderFirst: { onAtEntry: true, monotonicMs: 100, videoTimeMs: 1500, playbackRate: 1,
        adapterSelection: { selectedTranslation: false, choice: 'original', selectedAtMs: 101 } } }),
      record('cached', 101, { cacheHit: true }),
      record('outside', 104, { plannedVideoTimeMs: 999,
        initRenderFirst: { onAtEntry: true, monotonicMs: 104, videoTimeMs: 999, playbackRate: 1,
          adapterEvidence: { selectedTranslation: true, choice: 'translated', selectedAtMs: 105,
            preparedIdentity: { id: sourceId('outside'), originalText: 'source-outside', text: 'translation' } } } }),
      record('unknown', 107),
      record('rejected', 108),
      record('not-natural', 109, { initRenderFirst: { onAtEntry: false, monotonicMs: 109, videoTimeMs: 1500, playbackRate: 1 } }),
    ],
    cacheRows: [source('early', 'source-early'), source('cached', 'source-cached'),
      source('outside', 'source-outside'), source('rejected', 'source-rejected', { translatable: false })],
    watchEvents: [
      { event: 'request-start', requestId: 'q-early', atMs: 80, items: [{ id: sourceId('early'), text: 'source-early' }] },
      { event: 'request-end', requestId: 'q-early', atMs: 90, items: [{ id: sourceId('early'), status: 'translated' }] },
      { event: 'item-result', requestId: 'q-early', id: sourceId('early'), status: 'translated', atMs: 89 },
      { event: 'prepared', atMs: 90, items: [{ id: sourceId('early'), originalText: 'source-early', text: 'translation-early' }] },
      { event: 'prepared', atMs: 110, items: [{ id: sourceId('outside'), originalText: 'source-outside', text: 'translation' }] },
    ],
    visibleEvents: [{ dmid: 'early', text: 'translation-early', monotonicMs: 120, presentAtStart: false }],
  });
  const result = analyzeRun(input, { rawSha256: 'A'.repeat(64) });

  assert.equal(result.rawSha256, 'a'.repeat(64));
  assert.deepEqual(result.denominatorAccounting, {
    naturalInitRenderInPlaybackInterval: 6,
    onAtEntryTrue: 5,
    onAtEntryWithinPlannedSourceRange: 4,
    eligibleNaturalInitRenderDenominator: 3,
    unknownSourceMapping: 1,
    excludedByExistingGenericEligibility: 1,
    outsidePlannedSourceRange: 1,
    unaccountedNaturalInPlayback: 1,
    unaccountedWithinPlannedRange: 0,
    source: result.denominatorAccounting.source,
  });
  assert.equal(result.summary.timelyPrepared, 1);
  assert.equal(result.summary.latePrepared, 1);
  assert.equal(result.summary.missingPrepared, 1);
  assert.equal(result.summary.requestOutcomes['reused-without-watch-request'], 1);
  assert.equal(result.rows.find(row => row.dmid === 'cached').cacheHit, true);
  assert.equal(result.rows.find(row => row.dmid === 'cached').preparation, 'missing');
  assert.equal(result.rows.find(row => row.dmid === 'early').adapterSelection.selectedTranslation, false);
  assert.equal(result.rows.find(row => row.dmid === 'outside').adapterSelection.selectedTranslation, true);
  assert.equal(result.rows.find(row => row.dmid === 'cached').adapterSelection.status, 'unknown');
  assert.equal(result.rows.find(row => row.dmid === 'early').translatedVisible, true);
  assert.equal(result.rows.find(row => row.dmid === 'outside').visibilityUnknown, true);
});

test('dispatch evidence counts raw packet entries and flags a multi-item B request', () => {
  const input = rawRun({ single: true,
    records: [record('one', 100), record('two', 101)],
    cacheRows: [source('one', 'one'), source('two', 'two')],
    watchEvents: [{ event: 'request-start', requestId: 'multi', atMs: 90,
      items: [{ id: sourceId('one'), text: 'one' }, { id: sourceId('one'), text: 'one' }, { id: sourceId('two'), text: 'two' }] }],
  });
  const result = analyzeRun(input);
  assert.deepEqual(result.dispatch.itemsPerRequest, [3]);
  assert.equal(result.dispatch.packetSizeCounts['3'], 1);
  assert.equal(result.dispatch.rawItemEntries, 3);
  assert.equal(result.dispatch.duplicateWithinRequestIds.length, 1);
  assert.equal(result.validity.packetPolicy, 'invalid-multi-item-watch-packet');
});

test('compare keeps semantic A/B argument roles separate from observed B-then-A execution order', () => {
  const a = rawRun({ single: false, startedAt: '2026-09-26T10:05:00Z',
    records: [record('shared', 100), record('a-only', 120)],
    cacheRows: [source('shared', 'same-source'), source('a-only', 'only-a')],
    watchEvents: [{ event: 'request-start', requestId: 'a-pack', atMs: 80, items: [
      { id: sourceId('shared'), text: 'same-source' }, { id: sourceId('a-only'), text: 'only-a' }] },
      { event: 'request-end', requestId: 'a-pack', atMs: 130, items: [
        { id: sourceId('shared'), status: 'translated' }, { id: sourceId('a-only'), status: 'translated' }] },
      { event: 'prepared', atMs: 110, items: [{ id: sourceId('shared'), originalText: 'same-source', text: 'same-translation' }] },
    ],
    visibleEvents: [{ dmid: 'shared', text: 'same-translation', monotonicMs: 140, presentAtStart: false }] }),
  b = rawRun({ single: true, startedAt: '2026-09-26T10:00:00Z',
    records: [record('shared', 100, { initRenderFirst: { onAtEntry: true, monotonicMs: 100, playbackRate: 1,
      adapterEvidence: { selectedTranslation: true, choice: 'translated' } } }), record('b-only', 121)],
    cacheRows: [source('shared', 'same-source'), source('b-only', 'only-b')],
    watchEvents: [
      { event: 'request-start', requestId: 'b-1', atMs: 70, items: [{ id: sourceId('shared'), text: 'same-source' }] },
      { event: 'request-start', requestId: 'b-2', atMs: 75, items: [{ id: sourceId('b-only'), text: 'only-b' }] },
      { event: 'request-end', requestId: 'b-1', atMs: 90, items: [{ id: sourceId('shared'), status: 'translated' }] },
      { event: 'request-end', requestId: 'b-2', atMs: 100, items: [{ id: sourceId('b-only'), status: 'translated' }] },
      { event: 'prepared', atMs: 90, items: [{ id: sourceId('shared'), originalText: 'same-source', text: 'same-translation' }] },
    ],
    visibleEvents: [{ dmid: 'shared', text: 'same-translation', monotonicMs: 140, presentAtStart: false }] }),
  result = compare(a, b);

  assert.deepEqual(result.argumentMeaning.observedExecutionOrder, ['B', 'A']);
  assert.equal(result.argumentMeaning.executionOrderComesFromRunnerEvidence, true);
  assert.equal(result.primary.commonSources, 1);
  assert.equal(result.primary.common[0].id, sourceId('shared'));
  assert.equal(result.primary.common[0].existing.preparation, 'late');
  assert.equal(result.primary.common[0].single.preparation, 'timely');
  assert.equal(result.primary.common[0].leadDeltaSingleMinusExistingMs, 20);
  assert.equal(result.primary.nonCommon.onlyExisting.count, 1);
  assert.equal(result.primary.nonCommon.onlyExisting.rows[0].originalText, 'only-a');
  assert.equal(result.primary.nonCommon.onlySingle.count, 1);
  assert.equal(result.primary.nonCommon.onlySingle.rows[0].originalText, 'only-b');
  assert.equal(result.strategy.finding, 'watch-packet-strategy-difference-observed');
  assert.equal(result.comparability.environment.comparable, true);
  assert.equal(result.strategy.validForPolicyEvaluation, true);
  assert.equal(result.comparability.resourceIdEqual, true);
  assert.equal(result.comparability.cidEqual, true);
  assert.equal(result.comparability.executionOrderBThenA, true);
  assert.equal(result.comparability.aPacketEvidenceComplete, true);
  assert.equal(result.comparability.aPacketEvidenceConflictFree, true);
  assert.equal(result.comparability.exactCommonEventPresent, true);
  assert.equal(result.runs.single.summary.adapterSelection.explicitTranslatedSelection, 1);
});

test('configuration comparison ignores capture run IDs but retains substantive conditions', () => {
  const pair = comparablePair();
  assert.notEqual(pair.a.localExperiment.configuration.runId, pair.b.localExperiment.configuration.runId);
  const result = compare(pair.a, pair.b);
  assert.equal(result.comparability.configurationEqualExceptDispatch, true);
  assert.equal(result.strategy.validForPolicyEvaluation, true);
  assert.equal(result.runs.existing.runId, 'run-a');
  assert.equal(result.runs.single.runId, 'run-b');

  for (const [field, value] of Object.entries({
    prefetchSeconds: 10,
    budget: { maxInputItems: 54, maxInputChars: 600 },
    filterEnabled: false,
    engineConcurrency: 3,
  })) {
    const changed = comparablePair();
    changed.b.localExperiment.configuration[field] = value;
    const analysis = compare(changed.a, changed.b);
    assert.equal(analysis.comparability.configurationEqualExceptDispatch, false, field);
    assert.equal(analysis.strategy.validForPolicyEvaluation, false, field);
  }
});

test('policy evaluation requires matching explicit video identity and an observed B-then-A execution order', () => {
  const cases = [
    { name: 'resource ID unknown', change: ({ b }) => { delete b.identity.resourceId; }, field: 'resourceIdEqual', value: null },
    { name: 'resource ID different', change: ({ b }) => { b.identity.resourceId = 'resource-other'; }, field: 'resourceIdEqual', value: false },
    { name: 'CID unknown', change: ({ b }) => { delete b.identity.cid; }, field: 'cidEqual', value: null },
    { name: 'CID different', change: ({ b }) => { b.identity.cid = 'cid-other'; }, field: 'cidEqual', value: false },
    { name: 'B started after A', change: ({ a, b }) => { b.runnerEvidence.startedAt = '2026-09-26T10:06:00Z'; }, field: 'executionOrderBThenA', value: false },
    { name: 'B start time unknown', change: ({ b }) => { delete b.runnerEvidence.startedAt; }, field: 'executionOrderBThenA', value: false },
  ];
  for (const testCase of cases) {
    const pair = comparablePair(); testCase.change(pair);
    const result = compare(pair.a, pair.b);
    assert.equal(result.comparability[testCase.field], testCase.value, testCase.name);
    assert.equal(result.strategy.validForPolicyEvaluation, false, testCase.name);
    assert.ok(result.runs.existing && result.runs.single, 'invalid comparability retains both run analyses');
  }
});

test('policy evaluation requires complete conflict-free A packet evidence', () => {
  const truncated = comparablePair();
  truncated.a.localExperiment.watchEventsTruncated = true;
  const incompleteResult = compare(truncated.a, truncated.b);
  assert.equal(incompleteResult.comparability.aPacketEvidenceComplete, false);
  assert.equal(incompleteResult.strategy.validForPolicyEvaluation, false);

  const conflicted = comparablePair();
  conflicted.a.localExperiment.dispatch = { rawPacketSizes: { '2': 1 }, checkedPackets: 1, admittedPackets: 1,
    violationReason: 'dispatch-policy-violation' };
  const conflictedResult = compare(conflicted.a, conflicted.b);
  assert.equal(conflictedResult.comparability.aPacketEvidenceComplete, true);
  assert.equal(conflictedResult.comparability.aPacketEvidenceConflictFree, false);
  assert.equal(conflictedResult.strategy.validForPolicyEvaluation, false);

  const mismatched = comparablePair();
  mismatched.a.localExperiment.dispatch = { rawPacketSizes: { '2': 1 }, checkedPackets: 2, admittedPackets: 2 };
  const mismatchedResult = compare(mismatched.a, mismatched.b);
  assert.equal(mismatchedResult.comparability.aPacketEvidenceConflictFree, false);
  assert.equal(mismatchedResult.strategy.validForPolicyEvaluation, false);
});

test('policy evaluation needs a real A multi-item request and at least one exact common source event', () => {
  const noMulti = comparablePair();
  noMulti.a.localExperiment.watchEvents.find(event => event.event === 'request-start').items.pop();
  const noMultiResult = compare(noMulti.a, noMulti.b);
  assert.equal(noMultiResult.strategy.validForPolicyEvaluation, false);

  const noCommon = comparablePair();
  noCommon.b.records = [record('b-only', 100)];
  const noCommonResult = compare(noCommon.a, noCommon.b);
  assert.equal(noCommonResult.primary.commonSources, 0);
  assert.equal(noCommonResult.comparability.exactCommonEventPresent, false);
  assert.equal(noCommonResult.strategy.validForPolicyEvaluation, false);

  const unknownExactFields = comparablePair();
  for (const run of [unknownExactFields.a, unknownExactFields.b]) {
    run.localExperiment.report.resourceId = 'resource-r';
    run.localExperiment.configuration.playbackRate = 1;
    run.records[0].plannedVideoTimeMs = null;
    run.records[0].initRenderFirst.playbackRate = null;
  }
  const unknownResult = compare(unknownExactFields.a, unknownExactFields.b);
  assert.equal(unknownResult.primary.commonSources, 0, 'null times and rates are not exact source identity evidence');
  assert.equal(unknownResult.comparability.exactCommonEventPresent, false);
  assert.equal(unknownResult.strategy.validForPolicyEvaluation, false);
});

test('environment changes downgrade pair comparability; absent runner evidence stays unknown', () => {
  const baseA = rawRun({ records: [], cacheRows: [], watchEvents: [] });
  const baseB = rawRun({ single: true, records: [], cacheRows: [], watchEvents: [] });
  const changed = structuredClone(baseB);
  changed.runnerEvidence.environment = { status: 'stable', signature: { viewport: [1280, 800] },
    changes: [{ kind: 'viewport-resize', changed: true, atMs: 180 }] };
  const changedResult = compare(baseA, changed);
  assert.equal(changedResult.comparability.environment.comparable, false);
  assert.equal(changedResult.runs.single.runnerEnvironment.status, 'changed');
  assert.equal(changedResult.strategy.validForPolicyEvaluation, false);

  const noEvidence = structuredClone(baseA);
  delete noEvidence.runnerEvidence.environment;
  noEvidence.localExperiment.configuration.fromMs = null;
  noEvidence.localExperiment.configuration.toMs = null;
  const unknownResult = compare(noEvidence, baseB);
  assert.equal(unknownResult.comparability.environment.comparable, null);
  assert.equal(unknownResult.runs.existing.runnerEnvironment.status, 'unknown');
  assert.equal(unknownResult.comparability.nativeRangeEqual, null);
});
