// Pure accounting checks only. No configuration files, credentials, browsers or network calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkCompletionStatus, makeFeed, parseBenchmarkArgs, selectCorpus, summarizeTier, unicodeChars } from './benchmark-live-provider.mjs';

const completedTiers = () => [2, 4, 8, 16].map(concurrency => ({ concurrency, status: 'COMPLETE_CONTROLLED_LOAD' }));

test('benchmark completion retains successful, POST-limited and terminal-stop classifications', () => {
  const tiers = completedTiers();
  assert.equal(benchmarkCompletionStatus({ deadlineExceeded: false, stop: null, tiers }), 'COMPLETE_CONTROLLED_PROVIDER_BENCHMARK');
  tiers[3].status = 'COMPLETE_WITH_POST_BUDGET_LIMIT';
  assert.equal(benchmarkCompletionStatus({ deadlineExceeded: false, stop: null, tiers }), 'COMPLETE_CONTROLLED_PROVIDER_BENCHMARK');
  assert.equal(benchmarkCompletionStatus({ deadlineExceeded: false, stop: { reason: 'http-429' }, tiers }), 'STOPPED_NEW_REQUESTS');
});

test('last-tier watchdog cannot become a completed benchmark after every input is accounted', () => {
  const tiers = completedTiers();
  tiers[3] = { ...tiers[3], status: 'INCOMPLETE_TOTAL_TIME_BUDGET', events: [{ completionReason: 'total-time-budget' }] };
  assert.equal(benchmarkCompletionStatus({ deadlineExceeded: true, stop: null, tiers }), 'INCOMPLETE_TOTAL_TIME_BUDGET');
  assert.equal(benchmarkCompletionStatus({ deadlineExceeded: false, stop: null, tiers }), 'INCOMPLETE_TOTAL_TIME_BUDGET');
  assert.equal(benchmarkCompletionStatus({ deadlineExceeded: true, stop: null, tiers: completedTiers() }), 'INCOMPLETE_TOTAL_TIME_BUDGET');
});

test('running or missing final tiers cannot establish complete controlled load', () => {
  const tiers = completedTiers();
  tiers[3].status = 'running';
  assert.equal(benchmarkCompletionStatus({ deadlineExceeded: false, stop: null, tiers }), 'INCOMPLETE_BENCHMARK');
  assert.equal(benchmarkCompletionStatus({ deadlineExceeded: false, stop: null, tiers: tiers.slice(0, 3) }), 'INCOMPLETE_BENCHMARK');
});

test('deadline counts share all inputs as denominator, include queue time and use Unicode code points', () => {
  const outcomes = [
    { arrivedAtMs: 0, returnedAtMs: 500, dispatchedAtMs: 400, validOutputChars: unicodeChars('𠮷好'), completionReason: 'valid-output' },
    { arrivedAtMs: 100, returnedAtMs: 1100, dispatchedAtMs: 900, validOutputChars: 3, completionReason: 'valid-output' },
    { arrivedAtMs: 100, returnedAtMs: 2100, dispatchedAtMs: 1900, validOutputChars: 4, completionReason: 'valid-output' },
    { arrivedAtMs: 0, returnedAtMs: 3000, dispatchedAtMs: 2900, validOutputChars: 5, completionReason: 'valid-output' },
    { arrivedAtMs: 0, returnedAtMs: null, dispatchedAtMs: 100, validOutputChars: 0, completionReason: 'deadline-timeout' },
    { arrivedAtMs: 0, returnedAtMs: null, dispatchedAtMs: null, validOutputChars: 0, completionReason: 'http-429' },
    { arrivedAtMs: null, returnedAtMs: null, dispatchedAtMs: null, validOutputChars: 0, completionReason: 'input-window-ended-before-arrival' },
    { arrivedAtMs: 0, returnedAtMs: 200, dispatchedAtMs: 100, validOutputChars: 0, protocolValidOutputChars: 2, unchangedOutput: true, completionReason: 'unchanged-output' },
  ];
  const events = outcomes.map(event => ({ inputUnicodeChars: 2, scheduledArrivalAtMs: event.arrivedAtMs ?? 0,
    completedAtMs: event.returnedAtMs ?? 3000, protocolValidOutputChars: event.validOutputChars, ...event }));
  const result = summarizeTier({ events, requests: [], concurrency: 16, rate: 60 });
  assert.deepEqual(result.deadlines.map(row => row.validItems), [1, 2, 3, 4]);
  assert.deepEqual(result.deadlines.map(row => row.unicodeChars), [2, 5, 9, 14]);
  assert.ok(result.deadlines.every(row => row.denominator === 8));
  assert.equal(result.deadlines[0].successRate, 1 / 8);
  assert.equal(result.deadlines[3].successRate, 4 / 8);
  assert.equal(result.unchangedOutputItems, 1);
  assert.equal(result.queueWait.samples, 7);
  assert.equal(result.capacityLimitEstablished, false);
});

test('recorded corpus filtering precedes equal ordered replay and duplicate texts retain distinct IDs', () => {
  const corpus = selectCorpus([
    { originalText: 'かな', translatable: true }, { originalText: '😀', translatable: true },
    { originalText: '草ｗ', translatable: true }, { originalText: 'かな', translatable: true },
  ]);
  assert.equal(corpus.items.length, 2);
  assert.equal(corpus.excluded['no-translation-needed'], 2);
  const first = makeFeed(corpus.items, 'c2', 60), second = makeFeed(corpus.items, 'c16', 60);
  assert.equal(first.length, 1800);
  assert.deepEqual(first.map(event => event.corpusIndex), second.map(event => event.corpusIndex));
  assert.deepEqual(first.map(event => event.scheduledArrivalAtMs), second.map(event => event.scheduledArrivalAtMs));
  assert.equal(new Set([...first, ...second].map(event => event.id)).size, 3600);
  assert.deepEqual(corpus.items.map(item => item.text), ['かな', 'かな']);
});

test('peak local POST concurrency and HTTP duration retain failed attempts', () => {
  const requests = [
    { postedAtMs: 100, dispatchedAtMs: 90, completedAtMs: 3100, itemIds: ['a'], reason: 'deadline-timeout' },
    { postedAtMs: 200, dispatchedAtMs: 195, completedAtMs: 300, itemIds: ['b'], reason: 'http-429' },
  ];
  const result = summarizeTier({ events: [], requests, concurrency: 16, rate: 60 });
  assert.equal(result.peakActualConcurrency, 2);
  assert.equal(result.configuredConcurrencyReached, false);
  assert.equal(result.httpAttemptDurationIncludingTimeouts.samples, 2);
  assert.equal(result.httpAttemptDurationIncludingTimeouts.p95Ms, 3000);
  assert.equal(result.secondsAtConfiguredConcurrencyDuringFeed, 0);
});

test('CLI requires authorized model/profile, defaults thinking without fallback and bounds POST count', () => {
  const args = ['--config-file', 'not-read.txt', '--test-model', 'deepseek-flash', '--test-profile', 'deepseek', '--thinking', 'default'];
  assert.equal(parseBenchmarkArgs(args).maxRequests, 400);
  assert.equal(parseBenchmarkArgs([...args, '--max-requests', '800']).maxRequests, 800);
  assert.throws(() => parseBenchmarkArgs([...args, '--max-requests', '801']), /max-requests/);
  assert.equal(parseBenchmarkArgs(args.slice(0, -2)).thinkingEffort, 'default');
  assert.equal(parseBenchmarkArgs(args.map(value => value === 'default' ? 'off' : value)).thinkingEffort, 'off');
  assert.throws(() => parseBenchmarkArgs(args.map(value => value === 'default' ? 'low' : value)), /thinking-must-be/);
  assert.throws(() => parseBenchmarkArgs([...args, '--model', 'another-model']), /duplicate-model/);
});
