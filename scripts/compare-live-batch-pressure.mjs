// Paired deterministic load evidence only. No credentials, browser or real transport.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { runReplay } from './replay-translation-cost.mjs';

if (process.argv.includes('--help')) {
  console.log('node --experimental-strip-types scripts/compare-live-batch-pressure.mjs --baseline PATH\nPATH must be a preserved source directory within .artifacts/live/release-baselines. No paid requests.');
  process.exit(0);
}
const args = process.argv.slice(2);
assert.ok(args.length === 2 && args[0] === '--baseline', 'Explicit preserved source baseline required');
const baseline = await realpath(resolve(args[1]));
const allowed = await realpath(resolve('.artifacts/live/release-baselines'));
const tail = relative(allowed, baseline);
assert.ok(tail && !tail.startsWith('..') && !isAbsolute(tail), 'Baseline must be inside the workspace release-baselines directory');
const sourceFixture = JSON.parse(await readFile('test/fixtures/translation-cost-replay.json', 'utf8'));
const parent = resolve('.artifacts/live/batch-pressure'); await mkdir(parent, { recursive: true });
const directory = await mkdtemp(resolve(parent, 'run-'));
const summary = { capturedAt: new Date().toISOString(), baseline, realProviderRequests: 0, status: 'RUNNING', comparisons: [],
  scope: 'Paired production LiveScheduler and TranslationEngine with identical synthetic traffic and injected service delays',
  limitations: ['No real provider throughput, price, quality or physical display capacity is measured.',
    'Rates are unconfigured. Usage values inherited from the fixture are invented; no cost-saving claim.',
    'All eligible events, including expiry and capacity drops, remain in the paired denominator.',
    'These two injected latency curves cannot establish behavior for every real service.'] };
try {
  for (const curve of [{ name: 'fixed-800', baseMs: 800, perOutputUnitMs: 0 },
    { name: 'size-dependent', baseMs: 600, perOutputUnitMs: 1.5 }]) {
    const fixture = { ...sourceFixture, description: 'Bounded marginal-batching pressure diagnostic; synthetic only',
      rates: { currency: null }, settings: { ...sourceFixture.settings, concurrency: 16, batchSize: 10,
        liveMaxBatchWaitMs: 150, liveAdaptiveConcurrency: true },
      latency: { ...sourceFixture.latency, baseMs: curve.baseMs, perOutputUnitMs: curve.perOutputUnitMs },
      samples: [sourceFixture.samples[0]], profiles: [
        { name: 'high-unique', count: 900, intervalMs: 1000 / 300 },
        { name: 'high-repeat', count: 900, intervalMs: 1000 / 300, repeatPool: 120 },
        { name: 'mixed-length', count: 600, intervalMs: 4, longEvery: 10 },
      ] };
    const fixturePath = resolve(directory, `${curve.name}-fixture.json`);
    await writeFile(fixturePath, JSON.stringify(fixture, null, 2) + '\n');
    for (const bufferMs of [500, 1000, 2000, 3000]) {
      const report = await runReplay({ baseline, fixture: fixturePath, bufferMs, concurrency: 16, batchSize: 10, rates: { currency: null } });
      report.methodology.associations = 'Both preserved baseline and current supply actual engine occurrence/task/batch traces; logical text identity is separate.';
      const reportPath = resolve(directory, `${curve.name}-b${bufferMs}.json`);
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      for (const profile of report.profiles) {
        const extract = result => {
          assert.equal(result.schedulerStats.queued, 0);
          assert.equal(result.schedulerStats.received, result.occurrences.length);
          assert.equal(result.schedulerStats.released + result.schedulerStats.dropped + result.schedulerStats.removed, result.occurrences.length);
          assert.equal(result.engineStats.retries, 0);
          return { events: result.occurrences.length, eligible: result.summary.eligibleOccurrences,
            translated: result.schedulerStats.translated, original: result.schedulerStats.original,
            dropped: result.schedulerStats.dropped, syntheticRequests: result.attempts.length,
            singleItemRequests: result.attempts.filter(row => row.batchSize === 1).length,
            peakConcurrency: result.maxActiveTransport, peakQueue: result.peakQueuedItems,
            onTimeCoverage: result.summary.onTimeCoverage };
        };
        summary.comparisons.push({ curve: curve.name, bufferMs, profile: profile.name,
          report: reportPath, baseline: extract(profile.baseline), current: extract(profile.current),
          coveragePreserved: profile.comparison.coveragePreserved });
      }
    }
  }
  summary.status = summary.comparisons.every(row => row.coveragePreserved) ? 'PASS_PAIRED_SYNTHETIC_COVERAGE' : 'FAIL_PAIRED_SYNTHETIC_COVERAGE';
} catch (error) {
  summary.status = 'INCOMPLETE_SYNTHETIC_DIAGNOSTIC'; summary.error = error.message;
  process.exitCode = 1;
}
const output = resolve(directory, 'summary.json'); await writeFile(output, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ output, status: summary.status, realProviderRequests: 0,
  comparisons: summary.comparisons.map(row => ({ curve: row.curve, bufferMs: row.bufferMs, profile: row.profile,
    requests: [row.baseline.syntheticRequests, row.current.syntheticRequests],
    translated: [row.baseline.translated, row.current.translated], dropped: [row.baseline.dropped, row.current.dropped],
    peakConcurrency: [row.baseline.peakConcurrency, row.current.peakConcurrency] })) }));
if (summary.status !== 'PASS_PAIRED_SYNTHETIC_COVERAGE') process.exitCode = 1;
