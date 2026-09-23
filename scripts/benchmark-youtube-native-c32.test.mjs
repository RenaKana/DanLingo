// Synthetic local checks only: no credential file, browser, artifact or network access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNativeC32Args, makeNativeC32Corpora, makeNativeC32Plan, summarizeNativeC32,
  nativeC32CompletionStatus, NATIVE_C32_LOAD, main } from './benchmark-youtube-native-c32.mjs';
import { makeOccurrences, runChainCondition } from './benchmark-live-chain.mjs';
import { DEFAULT_SETTINGS } from '../src/core/config.ts';

test('CLI pins scope and rejects destination/model/load overrides before any credential read', async () => {
  assert.deepEqual(parseNativeC32Args(['--config-file', 'never-read.txt', '--check-args']), {
    configFile: 'never-read.txt', checkArgs: true, help: false, model: 'deepseek-v4-flash', profile: 'deepseek', thinkingEffort: 'off' });
  for (const args of [[], ['--check-args'], ['--config-file'], ['--config-file', '--help'],
    ['--config-file', 'x', '--config-file', 'y'], ['--config-file', 'x', '--rate', '10'],
    ['--config-file', 'x', '--endpoint', 'https://wrong.invalid'], ['--config-file', 'x', '--model', 'other'],
    ['--config-file', 'x', '--mock']]) assert.throws(() => parseNativeC32Args(args));
  // A nonexistent path must succeed with --check-args; capture logs to verify path/value privacy.
  const logs = [], originalLog = console.log;
  console.log = value => logs.push(value);
  try { await main(['--config-file', 'nonexistent-sensitive-path-do-not-read.txt', '--check-args']); }
  finally { console.log = originalLog; }
  assert.equal(JSON.parse(logs[0]).status, 'ARGUMENTS_VALID_NO_CONFIG_READ_NO_REQUESTS');
  assert.ok(!logs.join('').includes('nonexistent-sensitive-path'));
  assert.equal(NATIVE_C32_LOAD.feedMs * NATIVE_C32_LOAD.rate / 1000, 3600);
  assert.deepEqual(makeNativeC32Plan().map(row => [row.corpus, row.concurrency, row.bufferMs, row.postQuota]),
    [['repeat', 32, 2000, 400], ['low-repeat', 32, 2000, 400]]);
});

test('corpora contain eligible deterministic sentences and low-repeat covers all 3600 unique inputs', () => {
  const first = makeNativeC32Corpora(), second = makeNativeC32Corpora();
  assert.equal(first.repeat.items.length, 32);
  assert.equal(first['low-repeat'].items.length, 3600);
  for (const [name, corpus] of Object.entries(first)) {
    assert.equal(corpus.metadata.orderedCorpusSha256, second[name].metadata.orderedCorpusSha256);
    assert.equal(corpus.metadata.uniqueTexts, corpus.items.length);
    assert.deepEqual(corpus.metadata.excluded, {});
    assert.ok(corpus.items.every(row => row.text.length <= 1000 && row.text.length > 10));
  }
  const repeatedFeed = makeOccurrences(first.repeat.items, 'r', 60, 60000);
  const uniqueFeed = makeOccurrences(first['low-repeat'].items, 'u', 60, 60000);
  assert.equal(repeatedFeed.length, 3600); assert.equal(uniqueFeed.length, 3600);
  assert.equal(new Set(repeatedFeed.map(row => row.uniqueId)).size, 32);
  assert.equal(new Set(uniqueFeed.map(row => row.uniqueId)).size, 3600);
  assert.ok(first['low-repeat'].items.every(row => !/\d/.test(row.text)), 'uniqueness must not rely on numeric suffixes');
});

test('summary preserves failed denominators, reports overlapping cache/duplicates and ordered callback delay', () => {
  const corpus = makeNativeC32Corpora().repeat.items.slice(0, 3);
  const occurrences = makeOccurrences(corpus, 'summary', 6, 1000);
  occurrences.forEach((row, index) => Object.assign(row, { receivedAt: index * 10, displayAt: index * 10 + 2000,
    outcome: 'original', releasedAt: 2000 + index * 10, releasedTranslated: false }));
  for (const index of [0, 1, 3]) Object.assign(occurrences[index], { validTranslation: true, readyAt: index * 10 + 100,
    outputUnicodeChars: 4, releasedTranslated: true, outcome: 'translated', releasedAt: index * 10 + 120 });
  occurrences[3].cached = true;
  occurrences[2].failures = ['quota-exceeded']; occurrences[4].failures = ['deadline-exceeded']; occurrences[5].failures = ['network-error'];
  const summary = summarizeNativeC32({ occurrences, attempts: [], feedMs: 1000, rate: 6, concurrency: 32,
    peakActualConcurrency: 2, schedulerStats: { timedOut: 1 } });
  assert.equal(summary.denominator, 6); assert.equal(summary.onTimeReadyItems, 3);
  assert.equal(summary.onTimeCoverage, 0.5); assert.equal(summary.onTimeReadyItemsPerFixedSecond, 3);
  assert.equal(summary.onTimeReadyCharsPerFixedSecond, 12);
  assert.deepEqual(summary.byText, { denominator: 3, onTimeReadyUniqueTexts: 2, uniqueTextCoverage: 2 / 3, repeatedInputOccurrences: 3 });
  assert.equal(summary.contribution.cacheHitOnTimeItems, 1); assert.equal(summary.contribution.duplicateTextOnTimeItems, 1);
  assert.equal(summary.contribution.nonCachedOnTimeUniqueTexts, 2);
  assert.equal(summary.readinessMs.p50Ms, 100); assert.equal(summary.readinessMs.p95Ms, 100);
  assert.equal(summary.orderedSimulatedRelease.translatedArrivalToReleaseMs.p95Ms, 120);
  assert.equal(summary.orderedSimulatedRelease.readyToReleaseMs.p95Ms, 20);
  assert.equal(summary.orderedSimulatedRelease.callbackSequenceObserved, false);
  assert.equal(summary.orderedSimulatedRelease.orderRegressions, null);
  assert.equal(summary.failureCounts.quotaExceededOccurrences, 1); assert.equal(summary.failureCounts.schedulerTimedOut, 1);
  assert.equal(summary.failureCounts.occurrenceReasons['network-error'], 1);
});

test('completion requires both complete full-duration C32 cells and the ordered release scope', () => {
  const rows = makeNativeC32Plan().map(row => ({ ...row, feedMs: 60000, rate: 60, releasePolicy: 'ready-in-order',
    status: 'COMPLETE_CONTROLLED_CHAIN', summary: { denominator: 3600 } }));
  assert.equal(nativeC32CompletionStatus(rows, null), 'COMPLETE_CONTROLLED_NODE_C32_OBSERVATION');
  assert.match(nativeC32CompletionStatus(rows.slice(0, 1), null), /^INCOMPLETE/);
  for (const patch of [{ status: 'INCOMPLETE_POST_BUDGET' }, { concurrency: 16 }, { releasePolicy: 'deadline' },
    { feedMs: 1000 }, { summary: { denominator: 100 } }]) {
    assert.match(nativeC32CompletionStatus([{ ...rows[0], ...patch }, rows[1]], null), /^INCOMPLETE/);
  }
  assert.match(nativeC32CompletionStatus(rows, { reason: 'total-time-budget' }), /^INCOMPLETE/);
});

function fakeClock() {
  let now = 0, nextId = 0;
  const timers = new Map();
  const clock = { now: () => now, wallNow: () => 1800000000000 + now,
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); } };
  return { clock, async pause(ms) {
    const until = now + ms;
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn();
      for (let index = 0; index < 20; index++) await Promise.resolve();
    }
    now = until;
    for (let index = 0; index < 20; index++) await Promise.resolve();
  } };
}

test('injected local public chain keeps fresh caches across serial cells and records simulated ordered release', async () => {
  const settings = { ...DEFAULT_SETTINGS, enabled: true, model: 'deepseek-v4-flash', profile: 'deepseek', thinkingEffort: 'off',
    endpoint: 'https://synthetic.invalid/v1/chat/completions', batchSize: 1, liveMaxBatchWaitMs: 0 };
  let posts = 0;
  const transport = async (_url, init) => {
    posts++;
    const body = JSON.parse(init.body), rows = body.messages.find(row => row.role === 'user').content.split('\n').filter(Boolean).map(JSON.parse);
    return Response.json({ choices: [{ message: { content: rows.map(row => JSON.stringify([row[0], '今天的直播很精彩。'])).join('\n') }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
  };
  for (const cell of makeNativeC32Plan()) {
    const condition = await runChainCondition({ cell: { ...cell, bufferMs: 200 }, corpus: makeNativeC32Corpora().repeat.items.slice(0, 1),
      settings, apiKey: 'synthetic-only', run: { maxRequests: 800, actualPosts: 0, stop: null },
      feedMs: 100, rate: 20, releasePolicy: 'ready-in-order', transport, ...fakeClock() });
    assert.equal(condition.status, 'COMPLETE_CONTROLLED_CHAIN'); assert.equal(condition.releasePolicy, 'ready-in-order');
    assert.equal(condition.actualPosts, 1); assert.equal(condition.summary.localCacheItems, 1);
    assert.ok(condition.occurrences.every(row => row.releasedAt < row.displayAt && row.releasedTranslated));
    const release = summarizeNativeC32(condition).orderedSimulatedRelease;
    assert.equal(release.callbackSequenceObserved ? release.orderRegressions : release.timestampOrderRegressions, 0);
  }
  assert.equal(posts, 2);
});
