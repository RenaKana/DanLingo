import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTopologyPlans, isFatalRuntimeFailure, summarizeInstanceSamples } from './benchmark-local-instances.mjs';

test('topology plans preserve total unified KV and dispatch concurrency', () => {
  const plans = buildTopologyPlans(2048);
  assert.deepEqual(plans.map(plan => [plan.instanceCount, plan.parallelPerInstance, plan.contextTokensPerInstance]), [[1, 4, 2048], [2, 2, 1024]]);
  assert.ok(plans.every(plan => plan.totalUnifiedKvTokens === 2048));
  assert.ok(plans.every(plan => plan.totalDispatchConcurrency === 4));
});

test('summary counts only parser-valid translations for throughput and latency', () => {
  const summary = summarizeInstanceSamples([
    { status: 'valid', durationMs: 10 }, { status: 'valid', durationMs: 20 },
    { status: 'valid', durationMs: 30 }, { status: 'failed', reason: 'LOCAL_BENCHMARK_PROTOCOL_INVALID', durationMs: 40 },
    { status: 'timeout', durationMs: 50 },
  ], 100);
  assert.equal(summary.validTranslations, 3);
  assert.equal(summary.validThroughputPerSecond, 30);
  assert.deepEqual(summary.validLatencyMs, { meanMs: 20, p50Ms: 20, p95Ms: 30, p99Ms: 30, minMs: 10, maxMs: 30, samples: 3 });
  assert.equal(summary.timeout, 1);
  assert.equal(summary.invalidTranslations, 1);
});

test('device loss and OOM abort signals are fatal, ordinary timeout is not', () => {
  assert.equal(isFatalRuntimeFailure('LOCAL_GPU_DEVICE_LOST'), true);
  assert.equal(isFatalRuntimeFailure('WebGPU allocation failed: out of memory'), true);
  assert.equal(isFatalRuntimeFailure('LOCAL_BENCHMARK_TIMEOUT'), false);
});
