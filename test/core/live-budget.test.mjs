import test from 'node:test';
import assert from 'node:assert/strict';
import { validLiveBufferMs, MAX_TIMER_DELAY_MS } from '../../src/core/live-budget.ts';
import { normalizeSettings } from '../../src/core/config.ts';
import { timeoutRetryBudget } from '../../src/core/timeout-retry.ts';
import { sanitizeRuntimeDiagnostics } from '../../src/ui/live-diagnostics.ts';

test('custom live wait persists without preset clamping; invalid and overflowing timers remain rejected', () => {
  for (const value of [1, 4500, 7500, 60000, MAX_TIMER_DELAY_MS]) {
    assert.equal(validLiveBufferMs(value), true); assert.equal(normalizeSettings({ liveBufferMs: value }).liveBufferMs, value);
  }
  for (const value of [0, -1, 1.1, Infinity, NaN, '5000', MAX_TIMER_DELAY_MS + 1]) {
    assert.equal(validLiveBufferMs(value), false); assert.equal(normalizeSettings({ liveBufferMs: value }).liveBufferMs, 2000);
  }
  assert.equal(timeoutRetryBudget(7500, 1000), 8500);
  assert.equal(timeoutRetryBudget(MAX_TIMER_DELAY_MS, 1000), MAX_TIMER_DELAY_MS);
});

test('safe local diagnostics distinguish deadline phases and never copy model paths or text', () => {
  const result = sanitizeRuntimeDiagnostics({ engine: { localDiagnostics: { queuedDeadline: 2, runningDeadline: 3, qualityRejected: 4, forcedCalls: 5,
    modelPath: 'secret', last: { queueMs: 22.5, inferenceMs: 300, promptMs: NaN, outputTokens: 7, source: 'private text', nativeTask: 4 } } } });
  assert.deepEqual(result.globalEngine.local, { counts: { queuedDeadline: 2, runningDeadline: 3, qualityRejected: 4, forcedCalls: 5 }, last: { queueMs: 22.5, inferenceMs: 300, outputTokens: 7 } });
  assert.doesNotMatch(JSON.stringify(result), /secret|private|nativeTask/);
});
