// Read existing controlled observations only. No credentials, browser or network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { escalationEvidence } from './benchmark-live-chain.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('node --experimental-strip-types scripts/summarize-live-chain-observations.mjs REPORT_500 REPORT_1000 REPORT_2000 REPORT_3000\nRead-only input: four independent completed C16 observations with identical current source hashes, settings, corpus and load. Writes a new combined report. Does not claim simultaneous comparison or execute higher concurrency.');
  process.exit(0);
}
assert.equal(args.length, 4, 'Supply exactly four observation reports');
const hash = value => createHash('sha256').update(value).digest('hex');
const rows = [];
let reference;
for (const input of args) {
  const bytes = await readFile(resolve(input)), report = JSON.parse(bytes);
  assert.equal(report.status, 'COMPLETE_CONTROLLED_CHAIN_SINGLE_BUFFER_OBSERVATION');
  assert.equal(report.conditions.length, 1);
  assert.ok(Object.values(report.checks).every(value => value === true));
  const cell = report.conditions[0];
  assert.equal(cell.status, 'COMPLETE_CONTROLLED_CHAIN');
  assert.equal(cell.concurrency, 16);
  assert.equal(cell.accountingErrors.length, 0);
  assert.ok(cell.occurrences.every(event => event.releaseCallbackCount === 1));
  const identity = { sourceHashes: report.sourceHashes, selected: report.selected,
    corpusSha256: report.corpus.sha256, selectedOrderSha256: report.corpus.selectedOrderSha256,
    feedMs: cell.feedMs, rate: cell.rate };
  if (reference) assert.deepEqual(identity, reference, 'Observations differ in source/settings/corpus/load');
  else {
    reference = identity;
    for (const [file, expected] of Object.entries(report.sourceHashes)) {
      const path = resolve(file), local = relative(resolve('.'), path);
      assert.ok(local && !isAbsolute(local) && local !== '..' && !local.startsWith('..' + sep), 'Source must remain in workspace');
      assert.equal(hash(await readFile(path)), expected, 'Current source mismatch: ' + file);
    }
  }
  const ready = cell.occurrences.filter(event => event.releasedTranslated);
  const providerReady = ready.filter(event => !event.cached);
  const providerChanged = providerReady.filter(event => !event.unchangedOutput);
  const statusCounts = {};
  for (const attempt of cell.attempts) statusCounts[attempt.status] = (statusCounts[attempt.status] ?? 0) + 1;
  rows.push({ input: relative(resolve('.'), resolve(input)).replaceAll('\\', '/'), inputSha256: hash(bytes),
    bufferMs: cell.bufferMs, startedAt: cell.startedAt, finishedAt: cell.finishedAt,
    status: cell.status, summary: cell.summary, providerStatusCounts: statusCounts,
    providerReadyEvents: providerReady.length, providerChangedEvents: providerChanged.length,
    providerChangedUnicodeChars: providerChanged.reduce((total, event) => total + event.outputUnicodeChars, 0),
    providerSuccessfulUniqueTasks: new Set(providerReady.map(event => event.engineTaskId)).size,
    usageKnownAttempts: cell.attempts.filter(attempt => attempt.usageKnown).length,
    usageUnknownAttempts: cell.attempts.filter(attempt => !attempt.usageKnown).length,
    gateRecomputedFromRecordedSamples: escalationEvidence(cell),
    accountingErrors: cell.accountingErrors, everyEventReleasedExactlyOnce: true });
}
rows.sort((a, b) => a.bufferMs - b.bufferMs);
assert.deepEqual(rows.map(row => row.bufferMs), [500, 1000, 2000, 3000]);
const root = resolve('.artifacts/live/provider-chain-benchmark'); await mkdir(root, { recursive: true });
const directory = await mkdtemp(resolve(root, 'combined-'));
const output = resolve(directory, 'report.json');
const result = { capturedAt: new Date().toISOString(), status: 'COMPLETE_FOUR_INDEPENDENT_C16_OBSERVATIONS',
  sourceHashes: reference.sourceHashes, selected: reference.selected, corpusSha256: reference.corpusSha256,
  load: { rate: reference.rate, feedMs: reference.feedMs }, rows,
  higherConcurrency: 'NOT_EXECUTED_BY_THIS_READ_ONLY_SUMMARY',
  limitations: ['Four separate times and independent empty caches, not a simultaneous paired comparison.',
    'Counts and rates include cache reuse. Provider-ready events may share one task; these are not independent model generations.',
    'No live page, browser IPC, track capacity or physical display is measured. No changed buffer/default/settings.',
    'Recomputed gates are observations only; no later C32/C64 run is implied. All original reports and full time buckets retained.'] };
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output, status: result.status, rows: rows.map(row => ({ bufferMs: row.bufferMs,
  ready: row.summary.onTimeReadyItems, denominator: row.summary.denominator,
  chars: row.summary.onTimeReadyUnicodeChars, peak: row.summary.peakActualConcurrency,
  posts: row.summary.actualPosts, gate: row.gateRecomputedFromRecordedSamples })) }));
