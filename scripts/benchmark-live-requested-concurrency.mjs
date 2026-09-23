// Explicit user-requested C32/C64 burst observation. No production settings changes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSettings } from '../src/core/config.ts';
import { needsTranslation } from '../src/core/messages.ts';
import { protectText } from '../src/translation/text.ts';
import { readAuthorizedLiveConfig } from './authorized-live-config.mjs';
import { runChainCondition, CORPUS_PATH } from './benchmark-live-chain.mjs';
import { selectCorpus, unicodeChars } from './benchmark-live-provider.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// No credential in argv, files or output. Raw terminal mode suppresses echo.
export async function readOfficialStdinConfig(input = process.stdin) {
  const wasRaw = input.isRaw;
  if (input.isTTY) input.setRawMode(true);
  let secret = '';
  try {
    secret = await new Promise((resolve, reject) => {
      let buffered = '';
      const finish = (error, value) => {
        input.off('data', onData); input.off('end', onEnd); input.off('error', onError);
        buffered = ''; input.pause(); error ? reject(error) : resolve(value);
      };
      const onEnd = () => finish(new Error('credential-input-ended'));
      const onError = () => finish(new Error('credential-input-failed'));
      const onData = data => {
        buffered += data.toString('utf8');
        if (buffered.includes('\u0003') || buffered.length > 256) return finish(new Error('invalid-credential-input'));
        if (/[\r\n]/.test(buffered)) {
          const value = buffered.split(/[\r\n]/, 1)[0];
          if (!/^sk-[A-Za-z0-9_-]{16,200}$/.test(value)) return finish(new Error('invalid-credential-input'));
          finish(null, value);
        }
      };
      input.on('data', onData); input.once('end', onEnd); input.once('error', onError); input.resume();
      if (input === process.stdin) console.log('OFFICIAL_CREDENTIAL_INPUT_READY_NO_ECHO');
    });
    return { settings: normalizeSettings({ endpoint: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-v4-flash', profile: 'deepseek', thinkingEffort: 'off', allowLocalHttp: false }), apiKey: secret };
  } finally {
    secret = '';
    if (input.isTTY) input.setRawMode(Boolean(wasRaw));
  }
}
export const REQUESTED_PLAN = [32, 64].flatMap(concurrency => [2000, 2500, 3000].map(bufferMs =>
  ({ id: `burst-b${bufferMs}-c${concurrency}`, concurrency, bufferMs, scope: 'explicit-requested-burst' })));

export function uniqueBurstCorpus(corpus, count = 1000) {
  assert.ok(corpus.length && Number.isInteger(count) && count >= 1 && count <= 1000);
  const rows = Array.from({ length: count }, (_, index) => {
    const original = corpus[index % corpus.length];
    const text = `${original.text} [${String(index + 1).padStart(4, '0')}]`;
    assert.ok(text.length <= 1000 && !protectText(text).reason && needsTranslation(text, 'zh-Hans', 'auto'), 'derived input must remain eligible');
    return { ordinal: index, text, textSha256: hash(text), unicodeChars: unicodeChars(text) };
  });
  assert.equal(new Set(rows.map(row => row.textSha256)).size, count);
  assert.ok(rows.reduce((sum, row) => sum + row.text.length, 0) <= 60000, 'retain production character quota');
  return rows;
}

export function requestedBudget(actualPosts, index, cap = 800) {
  // Protect one complete 100-request wave for every later condition.
  return Math.max(0, cap - actualPosts - (REQUESTED_PLAN.length - index - 1) * 100);
}

export async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('node --experimental-strip-types scripts/benchmark-live-requested-concurrency.mjs --config-file PATH | --official-stdin\nExplicit C32/C64 x 2000/2500/3000ms burst; 1000 unique numbered events per cell, batch10, 800 total POST cap, 120s total bound. Real Provider. Official mode reads the key without terminal echo and pins api.deepseek.com.');
    return;
  }
  const officialStdin = args.length === 1 && args[0] === '--official-stdin';
  assert.ok(officialStdin || args.length === 2 && args[0] === '--config-file', 'explicit config file or official stdin required');
  const authorized = officialStdin ? await readOfficialStdinConfig() : await readAuthorizedLiveConfig(args[1]);
  const settings = normalizeSettings({ ...authorized.settings, enabled: true, displayMode: 'translated', model: 'deepseek-v4-flash',
    profile: 'deepseek', thinkingEffort: 'off', sourceLanguage: 'auto', liveSourceLanguage: 'auto', targetLanguage: 'zh-Hans',
    batchSize: 10, liveMaxBatchWaitMs: 150, translationStream: false });
  const raw = await readFile(CORPUS_PATH), selected = selectCorpus(JSON.parse(raw).observation?.events, 'auto', 'zh-Hans');
  const corpus = uniqueBurstCorpus(selected.items);
  const parent = resolve('.artifacts/live/goals/g2'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'requested-concurrency-'));
  const sourceHashes = {};
  for (const name of ['src/core/live-scheduler.ts', 'src/core/config.ts', 'src/translation/engine.ts', 'src/translation/provider.ts',
    'src/translation/cache.ts', 'src/translation/clock.ts', 'src/translation/telemetry.ts', 'src/translation/text.ts',
    'scripts/benchmark-live-chain.mjs', 'scripts/benchmark-live-requested-concurrency.mjs', 'scripts/translation-cost-metrics.mjs'])
    sourceHashes[name] = hash(await readFile(new URL(`../${name}`, import.meta.url)));
  const report = { capturedAt: new Date().toISOString(), status: 'RUNNING', sourceHashes,
    providerRoute: officialStdin ? { source: 'explicit-user-official-key-via-stdin', endpoint: settings.endpoint } : { source: 'authorized-config-file' },
    selected: { model: settings.model, profile: settings.profile, thinkingEffort: settings.thinkingEffort, stream: false,
      batchSize: 10, liveMaxBatchWaitMs: 150, adaptiveConcurrency: settings.liveAdaptiveConcurrency },
    authorization: 'User explicitly requested C32/C64 at 2000/2500/3000ms; separate experiment, not automatic gate promotion.',
    load: { pattern: '1000 unique numbered events scheduled at zero', eventsPerCell: 1000, feedMs: 1000,
      maxActualPosts: 800, maxRunMs: 120000, plan: REQUESTED_PLAN },
    corpus: { sourceSha256: hash(raw), selectedOriginalUnique: new Set(selected.items.map(row => row.textSha256)).size,
      derivedOrderSha256: hash(JSON.stringify(corpus.map(row => row.textSha256))),
      inputUnicodeChars: corpus.reduce((sum, row) => sum + row.unicodeChars, 0),
      derivation: 'Original recorded text plus a distinct four-digit bracketed ordinal. Synthetic uniqueness, not new real-platform events.' },
    conditions: [], limits: ['The 2500ms cell is held in memory for this run; no settings are saved.',
      'Production 1000-entry capacity, 1200 unique/60000 character quota, normal cache, batching, deadlines and adaptive controls stay enabled.',
      'Burst latency is not sustained streaming capacity, and is not comparable with the earlier 60/s cache-heavy replay.',
      'No browser IPC or platform display. A configured cap is not evidence of reaching it; report actual overlap.',
      'Stop on HTTP401/403/429, total POST/time budget or interruption; do not force later conditions to pass.'] };
  const run = { maxRequests: 800, actualPosts: 0, stop: null, deadlineAt: performance.now() + 120000 };
  const stop = () => { run.stop ??= { reason: 'interrupted', actualPostsAtStop: run.actualPosts }; };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const output = resolve(root, 'report.json');
  try {
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    for (const [index, cell] of REQUESTED_PLAN.entries()) {
      if (run.stop) { report.conditions.push({ ...cell, status: 'NOT_RUN_STOP', reason: run.stop.reason, plannedDenominator: 1000 }); continue; }
      const postQuota = requestedBudget(run.actualPosts, index);
      console.log(JSON.stringify({ condition: cell.id, status: 'STARTED', postQuota }));
      const result = await runChainCondition({ cell: { ...cell, postQuota }, corpus, settings, apiKey: authorized.apiKey,
        run, feedMs: 1000, rate: 1000, burst: true });
      assert.ok(result.occurrences.every(row => row.displayAt === null || Math.abs(row.displayAt - row.receivedAt - cell.bufferMs) < 0.001), 'actual buffer mismatch');
      result.requestedConcurrencyReached = result.peakActualConcurrency === cell.concurrency;
      report.conditions.push(result);
      report.actualPosts = run.actualPosts; report.stop = run.stop;
      await writeFile(output, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ condition: cell.id, status: result.status, ready: result.summary.onTimeReadyItems,
        denominator: result.summary.denominator, actualPeak: result.peakActualConcurrency, actualPosts: result.actualPosts }));
    }
    report.status = report.conditions.every(row => row.status === 'COMPLETE_CONTROLLED_CHAIN')
      ? 'COMPLETE_REQUESTED_CONCURRENCY_OBSERVATIONS' : 'INCOMPLETE_REQUESTED_CONCURRENCY_OBSERVATIONS';
  } catch { report.status = 'INCOMPLETE_REQUESTED_RUNNER_ERROR'; process.exitCode = 1; }
  finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop); authorized.apiKey = '';
    report.actualPosts = run.actualPosts; report.stop = run.stop; report.finishedAt = new Date().toISOString();
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ output, status: report.status, actualPosts: report.actualPosts }));
  if (!report.status.startsWith('COMPLETE_')) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => { console.error('requested-benchmark-setup-failed'); process.exitCode = 1; });
}
