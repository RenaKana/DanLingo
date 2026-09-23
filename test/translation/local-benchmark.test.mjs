import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_BENCHMARK_CORPUS,
  aggregateLocalBenchmark,
  benchmarkPercentile,
  recommendLocalBenchmark,
} from '../../src/local/benchmark.ts';

test('benchmark corpus has distinct meaningful prompts in all requested workload bins', () => {
  assert.ok(LOCAL_BENCHMARK_CORPUS.filter(row => row.workload === 'short').length >= 16);
  assert.ok(LOCAL_BENCHMARK_CORPUS.filter(row => row.workload === 'normal').length >= 16);
  assert.ok(LOCAL_BENCHMARK_CORPUS.filter(row => row.workload === 'long').length >= 8);
  assert.equal(new Set(LOCAL_BENCHMARK_CORPUS.map(row => row.id)).size, LOCAL_BENCHMARK_CORPUS.length);
  assert.equal(new Set(LOCAL_BENCHMARK_CORPUS.map(row => row.text)).size, LOCAL_BENCHMARK_CORPUS.length);
  assert.ok(LOCAL_BENCHMARK_CORPUS.some(row => /[ぁ-んァ-ン一-龯]/u.test(row.text)));
  assert.ok(LOCAL_BENCHMARK_CORPUS.some(row => /[가-힣]/u.test(row.text)));
  for (const text of ['草', '真的假的', '好可爱', '笑死了', 'ㅋㅋㅋㅋ']) assert.ok(LOCAL_BENCHMARK_CORPUS.some(row => row.text === text));
  assert.ok(LOCAL_BENCHMARK_CORPUS.some(row => /\bthe\b|\bstream\b/i.test(row.text)));
});

test('benchmark percentile uses nearest rank and ignores no observations only by returning null', () => {
  assert.equal(benchmarkPercentile([], 0.95), null);
  assert.equal(benchmarkPercentile([50, 10, 100, 20], 0.5), 20);
  assert.equal(benchmarkPercentile([50, 10, 100, 20], 0.95), 100);
  assert.equal(benchmarkPercentile([5, Number.NaN, -1, 15], 0.5), 5);
});

test('benchmark aggregation keeps measured status, timing, token coverage, and GPU evidence separate', () => {
  const stats = aggregateLocalBenchmark([
    { id: 'a', workload: 'short', admittedAt: 0, startedAt: 15, finishedAt: 100, status: 'success', queueMs: 15, promptMs: 20, decodeMs: 65, inputTokens: 100, outputTokens: 40, gpuExecutionMs: 80, gpuAllocatedBytes: 1000 },
    { id: 'b', workload: 'normal', admittedAt: 100, startedAt: 130, finishedAt: 260, status: 'success', queueMs: 30, promptMs: 25, decodeMs: 100, inputTokens: 200, outputTokens: 80, gpuExecutionMs: null },
    { id: 'c', workload: 'long', admittedAt: 200, startedAt: 250, finishedAt: 300, status: 'failed', inputTokens: undefined, outputTokens: 20, reason: 'invalid-response' },
    { id: 'd', workload: 'normal', admittedAt: 300, startedAt: 340, finishedAt: 500, status: 'timeout', queueMs: 40, inputTokens: 50, gpuExecutionMs: 120, gpuAllocatedBytes: 2000 },
    { id: 'e', workload: 'short', admittedAt: 500, finishedAt: 550, status: 'cancelled' },
  ]);

  assert.deepEqual({ total: stats.total, success: stats.success, failed: stats.failed, timeout: stats.timeout, cancelled: stats.cancelled },
    { total: 5, success: 2, failed: 1, timeout: 1, cancelled: 1 });
  assert.equal(stats.totalDurationMs, 550);
  assert.equal(stats.successRate, 0.4);
  assert.equal(stats.timeoutRate, 0.2);
  assert.ok(Math.abs(stats.requestsPerSecond - 2 / 0.55) < 1e-12);
  assert.deepEqual([stats.endToEndMs.meanMs, stats.endToEndMs.p50Ms, stats.endToEndMs.p95Ms, stats.endToEndMs.p99Ms, stats.endToEndMs.minMs, stats.endToEndMs.maxMs],
    [130, 100, 160, 160, 100, 160]);
  assert.equal(stats.queueMs.meanMs, 33.75);
  assert.equal(stats.queueMs.samples, 4);
  assert.equal(stats.promptMs.coverage, 0.4);
  assert.equal(stats.decodeMs.coverage, 0.4);
  assert.deepEqual(stats.inputTokens, { total: 350, perSecond: 350 / 0.55, measured: 3, missing: 2, coverage: 0.6 });
  assert.deepEqual(stats.outputTokens, { total: 140, perSecond: 140 / 0.55, measured: 3, missing: 2, coverage: 0.6 });
  assert.equal(stats.gpuExecutionMs.meanMs, 100);
  assert.equal(stats.gpuExecutionMs.samples, 2);
  assert.equal(stats.gpuAllocatedBytes, 2000);
  assert.equal(stats.gpuAllocationSamples, 2);
});

test('no successful observations do not produce fabricated latency, throughput, or GPU values', () => {
  const stats = aggregateLocalBenchmark([
    { id: 'failed', workload: 'normal', admittedAt: 10, finishedAt: 90, status: 'failed', promptMs: 12 },
    { id: 'timeout', workload: 'long', admittedAt: 100, finishedAt: 300, status: 'timeout', inputTokens: undefined, gpuExecutionMs: null },
  ]);
  assert.equal(stats.success, 0);
  assert.equal(stats.requestsPerSecond, null);
  assert.deepEqual(stats.endToEndMs, { meanMs: null, p50Ms: null, p95Ms: null, p99Ms: null, minMs: null, maxMs: null, samples: 0, coverage: 0 });
  assert.equal(stats.gpuExecutionMs, null);
  assert.equal(stats.gpuAllocatedBytes, null);
  assert.equal(stats.inputTokens.total, null);
  assert.equal(stats.inputTokens.perSecond, null);
  assert.equal(stats.inputTokens.missing, 2);
  assert.equal(stats.promptMs.meanMs, 12);
});

test('recommendation gates failures and selects eight when sixteen adds little throughput at much worse P95', () => {
  const rows = [11, 19, 31, 44, 47].map((requestsPerSecond, index) => ({
    parallel: [1, 2, 4, 8, 16][index],
    requestsPerSecond,
    p95Ms: [80, 95, 110, 150, 400][index],
    meanQueueMs: [2, 4, 7, 12, 30][index],
    gpuAllocatedBytes: [500, 700, 900, 1200, 2200][index],
    successRate: 0.99,
    timeoutRate: 0,
  }));
  const recommendation = recommendLocalBenchmark(rows);
  assert.equal(recommendation.recommendedParallel, 8);
  assert.match(recommendation.reason, /parallel=8/);
  assert.match(recommendation.reason, /6\.8%/);
  assert.equal(recommendation.ranked[0].parallel, 16);
  assert.equal(recommendation.eligible.length, 5);
  assert.match(recommendation.algorithm, /successRate >= 0\.95/);
  assert.match(recommendation.algorithm, /timeoutRate === 0/);
});

test('explicit custom parallel above 32 remains eligible without changing the default grid', () => {
  const result = recommendLocalBenchmark([
    { parallel: 32, requestsPerSecond: 20, p95Ms: 400, meanMs: 200, meanQueueMs: 100, gpuAllocatedBytes: null, successRate: 1, timeoutRate: 0 },
    { parallel: 33, requestsPerSecond: 30, p95Ms: 400, meanMs: 200, meanQueueMs: 100, gpuAllocatedBytes: null, successRate: 1, timeoutRate: 0 },
  ]);
  assert.equal(result.recommendedParallel, 33);
  assert.equal(result.eligible.length, 2);
});

test('recommendation ranks mean latency after P95 and before queue wait', () => {
  const common = { requestsPerSecond: 10, p95Ms: 400, gpuAllocatedBytes: null, successRate: 1, timeoutRate: 0 };
  const result = recommendLocalBenchmark([
    { ...common, parallel: 2, meanMs: 300, meanQueueMs: 1 },
    { ...common, parallel: 4, meanMs: 200, meanQueueMs: 100 },
    { ...common, parallel: 8, meanQueueMs: 0 },
  ]);
  assert.equal(result.recommendedParallel, 4);
  assert.deepEqual(result.ranked.map(row => row.parallel), [4, 2, 8]);
});

test('recommendation returns no choice when every candidate fails the quality gate', () => {
  const result = recommendLocalBenchmark([
    { parallel: 1, requestsPerSecond: 10, p95Ms: 10, meanQueueMs: 1, gpuAllocatedBytes: null, successRate: 0.94, timeoutRate: 0 },
    { parallel: 2, requestsPerSecond: 12, p95Ms: 20, meanQueueMs: 2, gpuAllocatedBytes: null, successRate: 1, timeoutRate: 0.01 },
  ]);
  assert.equal(result.recommendedParallel, null);
  assert.equal(result.recommended, null);
  assert.equal(result.ranked.length, 0);
  assert.match(result.reason, /No candidate/);
});

test('recommendation does not call equal zero P95 values a material latency improvement', () => {
  const result = recommendLocalBenchmark([
    { parallel: 1, requestsPerSecond: 10, p95Ms: 0, meanQueueMs: 0, gpuAllocatedBytes: null, successRate: 1, timeoutRate: 0 },
    { parallel: 2, requestsPerSecond: 10.5, p95Ms: 0, meanQueueMs: 1, gpuAllocatedBytes: null, successRate: 1, timeoutRate: 0 },
  ]);
  assert.equal(result.recommendedParallel, 2);
});
