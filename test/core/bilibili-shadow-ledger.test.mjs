import test from 'node:test';
import assert from 'node:assert/strict';
import { BilibiliShadowLedger } from '../../src/core/bilibili-shadow-ledger.ts';

const event = (type, overrides = {}) => ({
  type, id: '42', originalText: 'original', epoch: 0,
  mediaTimeMs: 7_000, wallTimeMs: 100, stimeMs: 10_000, ...overrides,
});

test('early shadow selection matches one native init and keeps raw native observations distinct from pixels', () => {
  const ledger = new BilibiliShadowLedger({ warmupMs: 0 });
  ledger.advance({ epoch: 0, mediaTimeMs: 0, wallTimeMs: 0 });
  const reasons = ['selected-by-rule'];
  ledger.record(event('shadowSelected', { reasons, predictedInitMs: 9_500, privateToken: 'do-not-export' }));
  reasons.push('later-mutation');
  ledger.record(event('nativeValidate', { mediaTimeMs: 9_000, wallTimeMs: 3_000, result: true }));
  ledger.record(event('nativeInitRender', { mediaTimeMs: 10_000, wallTimeMs: 4_100 }));
  ledger.record(event('nativeFirstShow', { mediaTimeMs: 10_100, wallTimeMs: 4_200 }));
  const report = ledger.report();

  assert.deepEqual(report.events[0].reasons, ['selected-by-rule']);
  assert.equal('privateToken' in report.events[0], false);
  assert.equal(report.events[0].wallTimeMs, 100);
  assert.deepEqual(report.classification.eventTypes,
    { shadowSelected: 1, nativeValidate: 1, nativeInitRender: 1, nativeFirstShow: 1 });
  assert.equal(report.classification.nativeValidateTrue, 1);
  assert.equal(report.firstShowIsVisiblePixelEvidence, false);
  assert.equal(report.overall.maturedPredictions, 1);
  assert.equal(report.overall.matchedPredictions, 1);
  assert.equal(report.overall.actualInit, 1);
  assert.equal(report.overall.precision, 1);
  assert.equal(report.overall.recall, 1);
  assert.deepEqual(report.overall.leadMs, {
    min: 4_000, p10: 4_000, p50: 4_000, samples: 1, atLeast3000Count: 1, atLeast3000Ratio: 1,
  });
  assert.equal(report.acceptance.passed, true);
  report.events[0].reasons.push('report-mutation');
  assert.deepEqual(ledger.report().events[0].reasons, ['selected-by-rule']);
});

test('a prediction first observed after native init never retroactively improves recall', () => {
  const ledger = new BilibiliShadowLedger({ warmupMs: 0 });
  ledger.record(event('nativeInitRender', { mediaTimeMs: 9_000, wallTimeMs: 10 }));
  ledger.record(event('shadowSelected', { mediaTimeMs: 9_100, wallTimeMs: 20 }));
  ledger.advance({ epoch: 0, mediaTimeMs: 12_000, wallTimeMs: 30 });
  assert.equal(ledger.report().overall.pendingPredictions, 1, 'the deadline is strict');
  ledger.advance({ epoch: 0, mediaTimeMs: 12_001, wallTimeMs: 31 });
  const report = ledger.report();
  assert.equal(report.overall.precision, 0);
  assert.equal(report.overall.recall, 0);
  assert.equal(report.overall.falsePositives, 1);
  assert.equal(report.overall.leadMs.samples, 0);
});

test('native init after the media deadline cannot erase a matured false positive', () => {
  const ledger = new BilibiliShadowLedger({ warmupMs: 0 });
  ledger.record(event('shadowSelected', { wallTimeMs: 100 }));
  ledger.advance({ epoch: 0, mediaTimeMs: 12_001, wallTimeMs: 3_000 });
  ledger.record(event('nativeInitRender', { mediaTimeMs: 12_100, wallTimeMs: 4_000 }));
  const report = ledger.report();
  assert.equal(report.overall.falsePositives, 1);
  assert.equal(report.overall.precision, 0);
  assert.equal(report.overall.actualInit, 1);
  assert.equal(report.overall.recall, 0);
});

test('mature false positives persist through interruption; an immature tail is censored', () => {
  const ledger = new BilibiliShadowLedger({ warmupMs: 0 });
  ledger.record(event('shadowSelected', { id: 'expired', wallTimeMs: 100 }));
  ledger.advance({ epoch: 0, mediaTimeMs: 12_001, wallTimeMs: 200 });
  ledger.record(event('shadowSelected', { id: 'tail', stimeMs: 20_000, mediaTimeMs: 12_001, wallTimeMs: 300 }));
  let report = ledger.report();
  assert.deepEqual(report.predictions.map(prediction => prediction.status), ['falsePositive', 'pending']);
  assert.equal(report.overall.maturedPredictions, 1);
  assert.equal(report.overall.precision, 0);
  ledger.invalidate('navigation');
  report = ledger.report();
  assert.deepEqual(report.predictions.map(prediction => prediction.status), ['falsePositive', 'censored']);
  assert.equal(report.predictions[1].censoredBy, 'navigation');
  assert.equal(report.overall.falsePositives, 1);
  assert.equal(report.overall.censoredPredictions, 1);
  assert.equal(report.overall.maturedPredictions, 1);
});

test('epoch and source text isolate predictions; old epoch events do not backfill new admissions', () => {
  const ledger = new BilibiliShadowLedger({ warmupMs: 0 });
  ledger.record(event('shadowSelected', { wallTimeMs: 100 }));
  ledger.advance({ epoch: 1, mediaTimeMs: 7_000, wallTimeMs: 500 });
  ledger.record(event('nativeInitRender', { epoch: 1, wallTimeMs: 4_000, mediaTimeMs: 10_000 }));
  ledger.record(event('shadowSelected', { epoch: 0, wallTimeMs: 1_000 }));
  ledger.record(event('shadowSelected', { epoch: 1, originalText: 'other', wallTimeMs: 4_100, mediaTimeMs: 10_100 }));
  ledger.record(event('nativeInitRender', { epoch: 1, wallTimeMs: 7_200, mediaTimeMs: 11_000 }));
  const report = ledger.report();
  assert.equal(report.classification.staleEvents, 1);
  assert.equal(report.overall.actualInit, 2);
  assert.equal(report.overall.predictedBeforeInit, 0);
  assert.equal(report.overall.censoredPredictions, 1);
  assert.equal(report.overall.pendingPredictions, 1);
});

test('repeated native admissions each enter the actual denominator and are explicitly counted', () => {
  const ledger = new BilibiliShadowLedger({ warmupMs: 0 });
  ledger.record(event('shadowSelected'));
  ledger.record(event('nativeInitRender', { wallTimeMs: 4_000, mediaTimeMs: 10_000 }));
  ledger.record(event('nativeInitRender', { wallTimeMs: 4_100, mediaTimeMs: 10_100 }));
  const report = ledger.report();
  assert.equal(report.overall.matchedPredictions, 1);
  assert.equal(report.overall.actualInit, 2);
  assert.equal(report.overall.predictedBeforeInit, 1);
  assert.equal(report.overall.recall, 0.5);
  assert.equal(report.classification.duplicateNativeInit, 1);
  assert.equal(report.predictions[0].selected.wallTimeMs, 100);
});

test('warmup observations count overall; steady state has its own real denominators and lead distribution', () => {
  const ledger = new BilibiliShadowLedger({ warmupMs: 5_000 });
  ledger.advance({ epoch: 0, mediaTimeMs: 0, wallTimeMs: 0 });
  ledger.record(event('shadowSelected', { id: 'warm', stimeMs: 2_000, mediaTimeMs: 1_000, wallTimeMs: 100 }));
  ledger.record(event('nativeInitRender', { id: 'warm', stimeMs: 2_000, mediaTimeMs: 2_000, wallTimeMs: 4_000 }));
  ledger.record(event('shadowSelected', { id: 'steady-a', stimeMs: 20_000, mediaTimeMs: 15_000, wallTimeMs: 5_000 }));
  ledger.record(event('nativeInitRender', { id: 'steady-a', stimeMs: 20_000, mediaTimeMs: 20_000, wallTimeMs: 8_000 }));
  ledger.record(event('shadowSelected', { id: 'steady-b', stimeMs: 30_000, mediaTimeMs: 25_000, wallTimeMs: 9_000 }));
  ledger.record(event('nativeInitRender', { id: 'steady-b', stimeMs: 30_000, mediaTimeMs: 30_000, wallTimeMs: 13_000 }));
  const { overall, steadyState, acceptance } = ledger.report();
  assert.equal(overall.actualInit, 3);
  assert.equal(overall.matchedPredictions, 3);
  assert.equal(steadyState.actualInit, 2);
  assert.equal(steadyState.maturedPredictions, 2);
  assert.deepEqual(steadyState.leadMs,
    { min: 3_000, p10: 3_000, p50: 3_000, samples: 2, atLeast3000Count: 2, atLeast3000Ratio: 1 });
  assert.equal(acceptance.passed, true);
});

test('prediction and actual use the same stime cohort despite wall-time crossing warmup', () => {
  const earlyWall = new BilibiliShadowLedger();
  earlyWall.advance({ epoch: 0, mediaTimeMs: 0, wallTimeMs: 0 });
  earlyWall.record(event('shadowSelected', { stimeMs: 6_000, mediaTimeMs: 1_000, wallTimeMs: 100 }));
  earlyWall.record(event('nativeInitRender', { stimeMs: 6_000, mediaTimeMs: 6_000, wallTimeMs: 4_100 }));
  assert.equal(earlyWall.report().steadyState.maturedPredictions, 1);
  assert.equal(earlyWall.report().steadyState.actualInit, 1);

  const lateWall = new BilibiliShadowLedger();
  lateWall.advance({ epoch: 0, mediaTimeMs: 0, wallTimeMs: 0 });
  lateWall.record(event('shadowSelected', { stimeMs: 4_000, mediaTimeMs: 1_000, wallTimeMs: 6_000 }));
  lateWall.record(event('nativeInitRender', { stimeMs: 4_000, mediaTimeMs: 4_000, wallTimeMs: 10_000 }));
  const report = lateWall.report();
  assert.equal(report.overall.matchedPredictions, 1);
  assert.equal(report.steadyState.maturedPredictions, 0);
  assert.equal(report.steadyState.actualInit, 0);
  assert.equal(report.acceptance.passed, false);
});

test('precision and recall below 90 percent independently block steady-state acceptance', () => {
  const lowPrecision = new BilibiliShadowLedger({ warmupMs: 0 });
  lowPrecision.record(event('shadowSelected', { id: 'match' }));
  lowPrecision.record(event('nativeInitRender', { id: 'match', mediaTimeMs: 10_000, wallTimeMs: 4_100 }));
  lowPrecision.record(event('shadowSelected', { id: 'fp', stimeMs: 20_000, mediaTimeMs: 11_000, wallTimeMs: 5_000 }));
  lowPrecision.advance({ epoch: 0, mediaTimeMs: 22_001, wallTimeMs: 7_000 });
  const precisionReport = lowPrecision.report();
  assert.equal(precisionReport.steadyState.precision, 0.5);
  assert.equal(precisionReport.steadyState.recall, 1);
  assert.equal(precisionReport.steadyState.leadMs.min, 4_000);
  assert.equal(precisionReport.acceptance.passed, false);
  assert.ok(precisionReport.acceptance.reasons.includes('precision-below-0.9'));
  assert.equal(lowPrecision.report({ fromStimeMs: 10_000, toStimeMs: 20_000 }).evaluation.acceptance.passed, false);

  const lowRecall = new BilibiliShadowLedger({ warmupMs: 0 });
  lowRecall.record(event('shadowSelected', { id: 'match' }));
  lowRecall.record(event('nativeInitRender', { id: 'match', mediaTimeMs: 10_000, wallTimeMs: 4_100 }));
  lowRecall.record(event('nativeInitRender', { id: 'miss', stimeMs: 20_000, mediaTimeMs: 20_000, wallTimeMs: 8_000 }));
  const recallReport = lowRecall.report();
  assert.equal(recallReport.steadyState.precision, 1);
  assert.equal(recallReport.steadyState.recall, 0.5);
  assert.equal(recallReport.steadyState.leadMs.min, 4_000);
  assert.equal(recallReport.acceptance.passed, false);
  assert.ok(recallReport.acceptance.reasons.includes('recall-below-0.9'));
  assert.equal(lowRecall.report({ fromStimeMs: 10_000, toStimeMs: 20_000 }).evaluation.acceptance.passed, false);
});

test('evaluation uses the same inclusive stime window for predictions and native admissions', () => {
  const ledger = new BilibiliShadowLedger({ warmupMs: 0 });
  ledger.advance({ epoch: 0, mediaTimeMs: 0, wallTimeMs: 0 });
  ledger.record(event('shadowSelected', { id: 'before', stimeMs: 9_000, wallTimeMs: 100 }));
  ledger.advance({ epoch: 0, mediaTimeMs: 11_001, wallTimeMs: 200 });
  ledger.record(event('shadowSelected', { id: 'lower', mediaTimeMs: 11_001, wallTimeMs: 300 }));
  ledger.record(event('nativeInitRender', { id: 'lower', mediaTimeMs: 11_500, wallTimeMs: 4_300 }));
  ledger.record(event('shadowSelected', { id: 'upper', stimeMs: 20_000, mediaTimeMs: 15_000, wallTimeMs: 5_000 }));
  ledger.record(event('nativeInitRender', { id: 'upper', stimeMs: 20_000, mediaTimeMs: 20_000, wallTimeMs: 62_000 }));
  ledger.record(event('nativeInitRender', { id: 'after', stimeMs: 30_000, mediaTimeMs: 30_000, wallTimeMs: 64_000 }));
  const report = ledger.report({ fromStimeMs: 10_000, toStimeMs: 20_000 });
  assert.equal(report.events.length, 6, 'window filtering never hides raw events');
  assert.equal(report.overall.precision, 2 / 3);
  assert.equal(report.overall.recall, 2 / 3);
  assert.equal(report.evaluation.fromStimeMs, 10_000);
  assert.equal(report.evaluation.toStimeMs, 20_000);
  assert.equal(report.evaluation.metrics.maturedPredictions, 2);
  assert.equal(report.evaluation.metrics.actualInit, 2);
  assert.equal(report.evaluation.metrics.precision, 1);
  assert.equal(report.evaluation.metrics.recall, 1);
  assert.equal(report.evaluation.metrics.leadMs.min, 4_000);
  assert.equal(report.evaluation.acceptance.passed, true);
  assert.equal(ledger.report().evaluation, null);
});

test('an unsettled or censored prediction blocks acceptance only in its evaluation cohort', () => {
  const ledger = new BilibiliShadowLedger({ warmupMs: 0 });
  ledger.record(event('shadowSelected', { id: 'matched', wallTimeMs: 100 }));
  ledger.record(event('nativeInitRender', { id: 'matched', mediaTimeMs: 10_000, wallTimeMs: 4_100 }));
  ledger.record(event('shadowSelected', { id: 'tail', stimeMs: 20_000, mediaTimeMs: 11_000, wallTimeMs: 5_000 }));

  const settled = ledger.report({ fromStimeMs: 10_000, toStimeMs: 10_000 });
  assert.equal(settled.evaluation.acceptance.passed, true);
  const pending = ledger.report({ fromStimeMs: 10_000, toStimeMs: 20_000 });
  assert.equal(pending.evaluation.metrics.precision, 1);
  assert.equal(pending.evaluation.metrics.recall, 1);
  assert.equal(pending.evaluation.metrics.pendingPredictions, 1);
  assert.equal(pending.evaluation.acceptance.passed, false);
  assert.ok(pending.evaluation.acceptance.reasons.includes('cohort-not-settled'));

  ledger.invalidate('interrupted');
  const censored = ledger.report({ fromStimeMs: 10_000, toStimeMs: 20_000 });
  assert.equal(censored.evaluation.metrics.precision, 1);
  assert.equal(censored.evaluation.metrics.recall, 1);
  assert.equal(censored.evaluation.metrics.censoredPredictions, 1);
  assert.equal(censored.evaluation.acceptance.passed, false);
  assert.ok(censored.evaluation.acceptance.reasons.includes('interrupted-predictions'));
});

test('three-second acceptance uses the minimum matched lead, not the average or majority', () => {
  const ledger = new BilibiliShadowLedger({ warmupMs: 0 });
  ledger.record(event('shadowSelected', { id: 'long', wallTimeMs: 100 }));
  ledger.record(event('nativeInitRender', { id: 'long', mediaTimeMs: 10_000, wallTimeMs: 4_100 }));
  ledger.record(event('shadowSelected', { id: 'short', stimeMs: 20_000, mediaTimeMs: 15_000, wallTimeMs: 5_000 }));
  ledger.record(event('nativeInitRender', { id: 'short', stimeMs: 20_000, mediaTimeMs: 20_000, wallTimeMs: 7_900 }));
  const report = ledger.report();
  assert.equal(report.steadyState.leadMs.min, 2_900);
  assert.equal(report.steadyState.leadMs.atLeast3000Count, 1);
  assert.equal(report.steadyState.leadMs.atLeast3000Ratio, 0.5);
  assert.equal(report.acceptance.passed, false);
  assert.ok(report.acceptance.reasons.includes('min-lead-below-3000ms'));
});

test('empty evidence never yields perfect ratios, and truncation invalidates acceptance', () => {
  const empty = new BilibiliShadowLedger().report();
  assert.equal(empty.overall.precision, null);
  assert.equal(empty.overall.recall, null);
  assert.equal(empty.overall.leadMs.atLeast3000Ratio, null);
  assert.equal(empty.acceptance.passed, false);

  const ledger = new BilibiliShadowLedger({ maxRecords: 2, warmupMs: 0 });
  ledger.record(event('shadowSelected', { wallTimeMs: 100 }));
  ledger.record(event('nativeInitRender', { mediaTimeMs: 10_000, wallTimeMs: 4_000 }));
  ledger.record(event('nativeFirstShow', { mediaTimeMs: 10_100, wallTimeMs: 4_100 }));
  const report = ledger.report();
  assert.equal(report.events.length, 2);
  assert.equal(report.truncated, true);
  assert.equal(report.acceptance.passed, false);
  assert.ok(report.acceptance.reasons.includes('truncated'));
  assert.equal(ledger.report({ fromStimeMs: 0, toStimeMs: 20_000 }).evaluation.acceptance.passed, false);
});
