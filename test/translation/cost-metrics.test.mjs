import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateAttemptCost, normalizeCostUsage, percentile, summarizeCostReplay } from '../../scripts/translation-cost-metrics.mjs';

const rates = { currency: 'USD', inputPerMillion: 2, outputPerMillion: 6, cacheReadPerMillion: 0.5 };

test('cached input and reasoning are subsets, not double-charged token totals', () => {
  const usage = normalizeCostUsage({ prompt_tokens: 1000, completion_tokens: 200,
    prompt_tokens_details: { cached_tokens: 800 }, completion_tokens_details: { reasoning_tokens: 150 } });
  const cost = calculateAttemptCost({ usage }, rates);
  assert.equal(cost.known, true);
  assert.ok(Math.abs(cost.amount - 0.002) < 1e-12);
});

test('cache writes need verified semantics and use the supplied currency and per-million prices', () => {
  const usage = { promptTokens: 1000, completionTokens: 100, cachedInputTokens: 200, cacheWriteTokens: 300 };
  assert.equal(calculateAttemptCost({ usage }, rates).reason, 'unverified-cache-write-accounting');
  const configured = { ...rates, currency: 'CNY', cacheWritePerMillion: 4, cacheWriteAccounting: 'included-in-prompt' };
  const included = calculateAttemptCost({ usage }, configured);
  assert.equal(included.currency, 'CNY'); assert.ok(Math.abs(included.amount - 0.0029) < 1e-12);
  const additional = calculateAttemptCost({ usage }, { ...configured, cacheWriteAccounting: 'additional' });
  assert.ok(Math.abs(additional.amount - 0.0035) < 1e-12);
});

test('partial, absent, invalid usage and absent discount breakdowns stay unknown', () => {
  for (const usage of [undefined, {}, { promptTokens: 10 }, { completionTokens: 10 }, { promptTokens: -1, completionTokens: 2 },
    { promptTokens: 10, completionTokens: 2, cachedInputTokens: 11 },
    { promptTokens: 10, completionTokens: 2, cachedInputTokens: 0, reasoningTokens: 3 }]) {
    assert.equal(calculateAttemptCost({ usage }, rates).amount, null);
  }
  assert.equal(calculateAttemptCost({ usage: { promptTokens: 10, completionTokens: 2 } }, rates).reason, 'missing-cache-breakdown');
  assert.equal(calculateAttemptCost({ usage: { promptTokens: 10, completionTokens: 2 }, usageComplete: false }, rates).reason, 'incomplete-usage');
  assert.equal(calculateAttemptCost({ usage: { promptTokens: 10, completionTokens: 2, cachedInputTokens: 0, totalTokens: 11 } }, rates).reason, 'inconsistent-totals');
});

test('every duplicate occurrence counts independently, skips stay outside eligible denominator, unknown cost prevents a total', () => {
  const occurrences = [
    { uniqueId: 'same', eligible: true, receivedAt: 0, displayAt: 100, readyAt: 30, validTranslation: true, releasedAt: 100, releasedTranslated: true },
    { uniqueId: 'same', eligible: true, receivedAt: 20, displayAt: 120, readyAt: 30, validTranslation: true, cached: true, releasedAt: 120, releasedTranslated: true },
    { uniqueId: 'late', eligible: true, receivedAt: 0, displayAt: 100, readyAt: 100, validTranslation: true, releasedAt: 100, releasedTranslated: false },
    { uniqueId: 'skipped', eligible: false, receivedAt: 0, displayAt: 100, releasedAt: 100, releasedTranslated: false },
  ];
  const summary = summarizeCostReplay({ occurrences, rates, attempts: [
    { status: 'failed-format', formatFailures: 1, usage: { promptTokens: 1000, completionTokens: 100, cachedInputTokens: 0 } },
    { status: 'timeout', retry: true },
  ] });
  assert.equal(summary.rawOccurrences, 4); assert.equal(summary.eligibleOccurrences, 3);
  assert.equal(summary.uniqueEligibleTexts, 2); assert.equal(summary.onTimeCoverage, 2 / 3);
  assert.equal(summary.retryAttempts, 1); assert.equal(summary.unknownCostAttempts, 1);
  assert.equal(summary.cost.total, null); assert.equal(summary.cost.per1000Raw, null);
  assert.ok(Math.abs(summary.cost.knownSubtotal - 0.0026) < 1e-12);
  assert.equal(summary.readinessMs.p50, 10); assert.equal(summary.readinessMs.p99, 30);
});

test('failed requests with reported usage are charged, and zero coverage has no per-on-time denominator', () => {
  const summary = summarizeCostReplay({ occurrences: [{ eligible: true, uniqueId: 'a' }], rates,
    attempts: [{ status: 'failed', usage: { promptTokens: 1000, completionTokens: 100, cachedInputTokens: 0 } }] });
  assert.ok(Math.abs(summary.cost.per1000Raw - 2.6) < 1e-12);
  assert.equal(summary.cost.per1000OnTime, null); assert.equal(summary.readinessMs.p95, null);
  assert.equal(percentile([2, 1, 9, 7], 95), 9);
});
