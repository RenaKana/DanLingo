import assert from 'node:assert/strict';

export const OBSERVATION_SCOPES = ['all', 'chat-closed', 'fullscreen-chat-closed'];

/** Reuse only the captured receipt cohort and its bounded drain, without waiting for later events. */
export function recordedPhaseEvidence(observed, { startAt, endAt, observedUntil }) {
  assert.ok([startAt, endAt, observedUntil].every(Number.isFinite) && endAt > startAt && observedUntil >= endAt, 'Complete recorded observation bounds required');
  const snapshot = observed.snapshots.filter(row => row.at <= observedUntil).at(-1);
  const batches = observed.events.filter(row => row.at >= startAt && row.at <= observedUntil && row.adapterSession === snapshot?.adapterSession)
    .map(row => ({ ...row, events: (row.events || []).filter(event => event.receivedAt >= startAt && event.receivedAt < endAt) }));
  const renders = observed.renders.filter(row => row.at >= startAt && row.at <= observedUntil);
  return { snapshot, batches, renders };
}

/** Position continuity supplements, and never replaces, the existing native playback checks. */
export function auditMediaProgress(samples, { startAt, observedUntil, minIntervalMs = 750, minProgressSeconds = 0.05,
  maxSampleGapMs = 2000, maxBoundaryGapMs = 250 } = {}) {
  const failures = [];
  const fail = (reason, index, details = {}) => failures.push({ reason, index, at: samples[index]?.at ?? null, ...details });
  if (!Number.isFinite(startAt) || !Number.isFinite(observedUntil) || observedUntil <= startAt) fail('invalid-observation-bounds', 0);
  if (samples.length < 2) fail('insufficient-position-samples', 0);
  if (!samples.length || !Number.isFinite(samples[0]?.at) || samples[0].at < startAt || samples[0].at - startAt > maxBoundaryGapMs) fail('missing-start-coverage', 0);
  if (!samples.length || !Number.isFinite(samples.at(-1)?.at) || samples.at(-1).at > observedUntil || observedUntil - samples.at(-1).at > maxBoundaryGapMs) fail('missing-drain-end-coverage', samples.length - 1);
  let checkedIntervals = 0;
  for (let i = 0; i < samples.length; i++) {
    const row = samples[i], time = row.playback?.time;
    if (!Number.isFinite(row.at) || !Number.isFinite(time) || time < 0) { fail('invalid-position-sample', i); continue; }
    if (!i) continue;
    const previous = samples[i - 1], elapsedMs = row.at - previous.at, progressSeconds = time - previous.playback?.time;
    if (!(elapsedMs > 0) || elapsedMs > maxSampleGapMs) fail('position-sample-gap', i, { elapsedMs });
    if (!Number.isFinite(progressSeconds) || progressSeconds < -minProgressSeconds) fail('media-position-reset', i, { progressSeconds });
    if (progressSeconds > elapsedMs / 1000 * 2 + 0.5) fail('media-position-jump', i, { elapsedMs, progressSeconds });
    // The last boundary sample may be less than a full polling interval after its predecessor.
    // Check it against the nearest earlier sample spanning at least minIntervalMs.
    let anchor = i - 1;
    while (anchor > 0 && row.at - samples[anchor].at < minIntervalMs) anchor--;
    const checkedMs = row.at - samples[anchor].at;
    if (checkedMs >= minIntervalMs) {
      checkedIntervals++;
      const advanced = time - samples[anchor].playback?.time;
      if (!(advanced > minProgressSeconds)) fail('media-not-advancing', i, { anchorAt: samples[anchor].at, elapsedMs: checkedMs, progressSeconds: advanced });
    }
  }
  if (!checkedIntervals) fail('insufficient-advancing-interval', samples.length - 1);
  return { healthy: failures.length === 0, checkedIntervals, sampleCount: samples.length,
    minIntervalMs, minProgressSeconds, maxSampleGapMs, maxBoundaryGapMs,
    sampledDurationMs: samples.length ? samples.at(-1).at - samples[0].at : null,
    mediaProgressSeconds: samples.length ? samples.at(-1).playback?.time - samples[0].playback?.time : null,
    firstFailure: failures[0] || null, failures };
}

/** Missing scope evidence fails closed; a later restoration cannot erase an earlier lost state. */
export function auditHiddenScope(samples, scope) {
  assert.ok(OBSERVATION_SCOPES.includes(scope), 'Unknown observation scope');
  if (scope === 'all') return { required: false, scope, healthy: true, sampleCount: samples.length, firstFailure: null, failures: [] };
  const failures = [];
  if (!samples.length) failures.push({ reason: 'missing-scope-samples', index: 0, at: null });
  samples.forEach((row, index) => {
    if (row.scopeState?.chatHidden !== true) failures.push({ reason: 'native-chat-not-hidden', index, at: row.at });
    if (scope === 'fullscreen-chat-closed' && (row.scopeState?.fullscreenActive !== true || row.scopeState?.fullscreenContainsOverlay !== true)) {
      failures.push({ reason: 'fullscreen-does-not-contain-overlay', index, at: row.at });
    }
  });
  return { required: true, scope, healthy: failures.length === 0, sampleCount: samples.length, firstFailure: failures[0] || null, failures };
}
