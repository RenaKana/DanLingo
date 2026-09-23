// Offline occurrence-level comparison. Never imports a provider or reads credentials.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function diagnoseCoverage(report) {
  return report.profiles.map(profile => {
    const { baseline, current } = profile;
    for (const result of [baseline, current]) {
      assert.equal(new Set(result.occurrences.map(row => row.id)).size, result.occurrences.length, 'duplicate occurrence ID');
      assert.equal(result.schedulerStats.received, result.occurrences.length, 'received denominator mismatch');
      assert.equal(result.schedulerStats.translated, result.occurrences.filter(row => row.releasedTranslated).length, 'translated ledger mismatch');
    }
    assert.deepEqual(baseline.occurrences.map(row => [row.id, row.receivedAt, row.displayAt, row.eligible]),
      current.occurrences.map(row => [row.id, row.receivedAt, row.displayAt, row.eligible]), 'paired denominator mismatch');
    const describe = (result, id) => {
      const occurrence = result.occurrences.find(row => row.id === id);
      const attempts = result.attempts.filter(row => row.uniqueIds.includes(occurrence.uniqueId)).map(attempt => {
        const dispatch = result.engineTrace.find(row => row.type === 'attempt' && row.batchId === attempt.engineBatchId);
        return { id: attempt.id, batchId: attempt.engineBatchId, sentAt: attempt.sentAt, completedAt: attempt.completedAt,
          batchSize: attempt.batchSize, status: attempt.status, remainingMsAtDispatch: occurrence.displayAt - attempt.sentAt,
          settledDurationMs: attempt.completedAt - attempt.sentAt,
          completionCensored: attempt.status !== 'ok', dispatch };
      });
      return { occurrence, attempts };
    };
    const before = new Map(baseline.occurrences.map(row => [row.id, row]));
    const after = new Map(current.occurrences.map(row => [row.id, row]));
    const ids = baseline.occurrences.map(row => row.id);
    const lostIds = ids.filter(id => before.get(id).releasedTranslated && !after.get(id).releasedTranslated);
    const gainedIds = ids.filter(id => !before.get(id).releasedTranslated && after.get(id).releasedTranslated);
    return { profile: profile.name, denominator: baseline.occurrences.length,
      eligible: baseline.occurrences.filter(row => row.eligible).length,
      beforeTranslated: baseline.schedulerStats.translated, afterTranslated: current.schedulerStats.translated,
      lost: lostIds.map(id => ({ id, before: describe(baseline, id), after: describe(current, id) })),
      gained: gainedIds.map(id => ({ id, before: describe(baseline, id), after: describe(current, id) })) };
  });
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('node scripts/diagnose-live-coverage-regression.mjs --report PATH\nReads one paired replay JSON; writes a unique .artifacts/live/goals/g2/coverage-* directory. No network.');
    return;
  }
  assert.ok(args.length === 2 && args[0] === '--report', 'one explicit --report PATH required');
  const input = resolve(args[1]), bytes = await readFile(input), source = JSON.parse(bytes);
  const profiles = diagnoseCoverage(source);
  const parent = resolve('.artifacts/live/goals/g2');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, 'coverage-'));
  const report = { capturedAt: new Date().toISOString(), status: profiles.some(row => row.lost.length > row.gained.length)
    ? 'EXPLAINED_PAIRED_COVERAGE_REGRESSION' : 'NO_NET_PAIRED_REGRESSION', realProviderRequests: 0,
    input: { path: input, sha256: hash(bytes) }, fixtureSha256: source.fixtureSha256,
    baseline: source.baseline, current: source.current, profiles,
    limitations: ['Historical deterministic replay, not a new runtime measurement.',
      'Cancelled request durations are censored; no unobserved service completion time is inferred.',
      'No browser IPC, platform display, model throughput or cost evidence.'] };
  const output = resolve(directory, 'report.json');
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, status: report.status, profiles: profiles.map(row => ({ profile: row.profile,
    denominator: row.denominator, translated: [row.beforeTranslated, row.afterTranslated], lost: row.lost.map(item => item.id),
    gained: row.gained.map(item => item.id) })) }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
