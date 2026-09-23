import assert from 'node:assert/strict';

/** Validation only; importing this helper cannot open a browser or read provider configuration. */
export function validateLifecycleAction({ action, occurrences = 0, realOnly, lifecycle, nextUrl, observationScope,
  metricsSeconds, explicitMetricsPosition }) {
  assert.ok(occurrences <= 1, '--lifecycle-action selects exactly one action');
  if (action === null) return;
  assert.ok(['off-on', 'pause-resume'].includes(action), '--lifecycle-action must be off-on or pause-resume');
  assert.ok(realOnly, '--lifecycle-action requires --real-only');
  assert.ok(!lifecycle && !nextUrl && observationScope === 'all', '--lifecycle-action is exclusive with --lifecycle, --next-url and focused observation scopes');
  assert.ok(!explicitMetricsPosition, '--lifecycle-action always measures immediately after recovery; --metrics-position is not applicable');
  assert.ok(Number.isInteger(metricsSeconds) && metricsSeconds >= 30 && metricsSeconds <= 120,
    '--lifecycle-action requires a complete 30..120 second metrics window and its original deadline drain');
}
