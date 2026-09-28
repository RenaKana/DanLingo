import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import {
  DEFAULT_DURATION_SECONDS, SAMPLE_INTERVAL_MS, TAIL_OBSERVATION_MS,
  buildShadowModuleBundle, eventCountsFrom, metricAcceptance, parseArgs, summarizePlaybackSamples,
} from './verify-bilibili-shadow.mjs';

test('argument parser uses conservative defaults and rejects evaluation windows shorter than 11 seconds', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.durationSeconds, DEFAULT_DURATION_SECONDS);
  assert.equal(defaults.browser, 'chromium');
  assert.equal(parseArgs(['--duration', '11']).durationSeconds, 11);
  assert.throws(() => parseArgs(['--duration', '10']), /at least 11 seconds|between 11 and 3600/);
  assert.throws(() => parseArgs(['--duration', '3601']), /between 11 and 3600/);
  assert.equal(parseArgs(['--help']).help, true);
});

test('event counts and acceptance metrics read the Bilibili session report ledger', () => {
  const metrics = { matchedPredictions: 4, actualInit: 4 };
  const acceptance = { passed: true, reasons: [] };
  const sessionReport = { ledger: {
    events: [{ type: 'shadowSelected' }, { type: 'nativeValidate' }, { type: 'nativeInitRender' },
      { type: 'nativeInitRender' }, { type: 'nativeFirstShow' }],
    classification: { eventTypes: { shadowSelected: 1, nativeValidate: 1, nativeInitRender: 2, nativeFirstShow: 1 } },
    evaluation: { metrics, acceptance }, overall: { actualInit: 5 }, steadyState: { actualInit: 3 },
  } };
  assert.deepEqual(eventCountsFrom(sessionReport), {
    shadowSelected: 1, nativeValidate: 1, nativeInitRender: 2, nativeFirstShow: 1,
  });
  assert.deepEqual(metricAcceptance(sessionReport), {
    metrics, acceptance, overall: { actualInit: 5 }, steadyState: { actualInit: 3 },
  });
});

test('tail duration is measured from the prediction cutoff and includes the cutoff playback state', () => {
  const samples = [];
  for (let timeMs = 0; timeMs <= 1000; timeMs += SAMPLE_INTERVAL_MS) {
    samples.push({ phase: 'prediction', monotonicMs: timeMs, videoTimeMs: 10_000 + timeMs,
      paused: false, seeking: false, playbackRate: 1, hidden: false, visibilityState: 'visible' });
  }
  for (let timeMs = 1250; timeMs <= 1000 + TAIL_OBSERVATION_MS; timeMs += SAMPLE_INTERVAL_MS) {
    samples.push({ phase: 'tail', monotonicMs: timeMs, videoTimeMs: 10_000 + timeMs,
      paused: false, seeking: false, playbackRate: 1, hidden: false, visibilityState: 'visible' });
  }
  const playback = summarizePlaybackSamples(samples, {
    requestedDurationMs: 1000,
    predictionStartVideoTimeMs: 10_000,
    predictionStartMonotonicMs: 0,
    tailStartVideoTimeMs: 11_000,
    tailStartMonotonicMs: 1000,
    tailBoundaryState: { paused: false, seeking: false, playbackRate: 1, hidden: false, visibilityState: 'visible' },
  });
  assert.equal(playback.prediction.mediaAdvanceMs, 1000);
  assert.equal(playback.prediction.qualifiesAsContinuousPlayback, true);
  assert.equal(playback.tail.mediaAdvanceMs, TAIL_OBSERVATION_MS);
  assert.equal(playback.tail.wallAdvanceMs, TAIL_OBSERVATION_MS);
  assert.equal(playback.tail.qualifiesAsContinuousPlayback, true);

  const interrupted = summarizePlaybackSamples(samples, {
    requestedDurationMs: 1000, tailStartVideoTimeMs: 11_000, tailStartMonotonicMs: 1000,
    tailBoundaryState: { paused: true, seeking: false, playbackRate: 1, hidden: false, visibilityState: 'visible' },
  });
  assert.equal(interrupted.tail.uninterrupted, false);
});

test('observer bundle exposes both APIs when evaluated as a browser IIFE', async () => {
  const bundle = await buildShadowModuleBundle();
  const context = { window: {} };
  runInNewContext(bundle.code, context);
  assert.equal(typeof context.window.__DLShadowModule.BilibiliShadowSession, 'function');
  assert.equal(typeof context.window.__DLShadowModule.resolveBilibiliBinding, 'function');
});
