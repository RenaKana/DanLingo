// Bounded synthetic checks only: no key files, browsers, artifacts or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../src/core/config.ts';
import { LiveScheduler } from '../src/core/live-scheduler.ts';
import { parseChainArgs, makePlan, makeOccurrences, inspectJsonlRequest, postBudgetReason,
  escalationEvidence, summarizeChain, chainCompletionStatus, runChainCondition,
  allocateConditionBudget, reconcileSchedulerOutcomes } from './benchmark-live-chain.mjs';

const args = ['--config-file', 'never-read.txt', '--test-model', 'deepseek-v4-flash', '--test-profile', 'deepseek', '--test-thinking', 'off'];
const settings = { ...DEFAULT_SETTINGS, enabled: true, displayMode: 'translated', endpoint: 'https://synthetic.invalid/v1/chat/completions',
  model: 'deepseek-v4-flash', profile: 'deepseek', thinkingEffort: 'off', sourceLanguage: 'ja', liveSourceLanguage: 'ja',
  targetLanguage: 'zh-Hans', translationStream: false, batchSize: 1, liveMaxBatchWaitMs: 0 };
const corpus = [{ ordinal: 0, text: 'おはよう', unicodeChars: 4 }, { ordinal: 1, text: 'こんばんは', unicodeChars: 5 }];
const makeRun = maxRequests => ({ maxRequests, actualPosts: 0, stop: null });
const eventLoopTurn = () => new Promise(resolve => setImmediate(resolve));

class ControlledClock {
  time = 0;
  nextId = 0;
  timers = new Map();
  now = () => this.time;
  wallNow = () => 1800000000000 + this.time;
  setTimeout = (callback, delayMs) => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.time + Math.max(0, delayMs), callback });
    return id;
  };
  clearTimeout = id => { this.timers.delete(id); };

  async advanceBy(delayMs) {
    await eventLoopTurn();
    const target = this.time + delayMs;
    for (let count = 0; count < 10000; count++) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > target) break;
      this.timers.delete(next[0]);
      this.time = next[1].at;
      next[1].callback();
      await eventLoopTurn();
      if (count === 9999) throw new Error('controlled-clock-timer-loop');
    }
    this.time = target;
    await eventLoopTurn();
  }
}

const reply = async (_url, init) => {
  const body = JSON.parse(init.body), input = body.messages.find(row => row.role === 'user').content.split('\n').filter(Boolean).map(JSON.parse);
  return Response.json({ choices: [{ message: { content: input.map(row => JSON.stringify([row[0], '你好'])).join('\n') }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
};

test('explicit service selection and bounded C16-first reservation require no file reads', () => {
  assert.equal(parseChainArgs(args).maxRequests, 800);
  assert.throws(() => parseChainArgs(args.slice(0, -2)), /explicit-deepseek/);
  assert.throws(() => parseChainArgs([...args, '--max-requests', '801']), /max-requests/);
  assert.throws(() => parseChainArgs([...args, '--endpoint', 'https://other.invalid']), /invalid/);
  const plan = makePlan(800);
  assert.deepEqual(plan.slice(0, 4).map(row => [row.bufferMs, row.concurrency]), [[500, 16], [1000, 16], [2000, 16], [3000, 16]]);
  assert.deepEqual(plan.slice(0, 4).map(row => row.postQuota), [256, 288, 128, 128]);
  assert.equal(plan.reduce((sum, row) => sum + row.postQuota, 0), 800);
  assert.deepEqual(makePlan(4).map(row => row.postQuota), [1, 1, 1, 1, null, null, null, null, null, null, null, null]);
});

test('C16 consumes only earlier unused budget; higher tiers need completed baselines and adequate remainder', () => {
  const plan = makePlan(800), run = makeRun(800);
  assert.equal(allocateConditionBudget(plan[0], plan, [], run).postQuota, 256);
  run.actualPosts = 186;
  const second = allocateConditionBudget(plan[1], plan, [], run);
  assert.equal(second.postQuota, 358); assert.equal(second.protectedBaselinePosts, 256);
  const baselines = plan.slice(0, 4).map((cell, index) => ({ ...cell, status: 'COMPLETE_CONTROLLED_CHAIN', actualPosts: [186, 226, 32, 32][index] }));
  run.actualPosts = 476;
  const higher = allocateConditionBudget(plan[4], plan, baselines, run);
  assert.equal(higher.minimumPosts, 279); assert.equal(higher.postQuota, 324); assert.equal(higher.eligible, true);
  run.actualPosts = 522;
  assert.equal(allocateConditionBudget(plan[4], plan, baselines, run).eligible, false);
  assert.equal(allocateConditionBudget(plan[4], plan, baselines.slice(0, 3), makeRun(800)).eligible, false);
  const completeWithSkippedUpgrade = [...baselines, { ...plan[4], status: 'NOT_EXERCISED_BUDGET' }];
  assert.equal(chainCompletionStatus(completeWithSkippedUpgrade, null), 'COMPLETE_CONTROLLED_CHAIN_OBSERVATION');
});

test('only-buffer selects exactly one independent C16 cell with the whole bounded budget', () => {
  assert.equal(parseChainArgs(args).onlyBuffer, undefined);
  for (const buffer of [500, 1000, 2000, 3000]) {
    const options = parseChainArgs([...args, '--only-buffer', String(buffer), '--max-requests', '600']);
    const plan = makePlan(options.maxRequests, options.onlyBuffer);
    assert.equal(plan.length, 1); assert.equal(plan[0].bufferMs, buffer); assert.equal(plan[0].concurrency, 16);
    assert.equal(plan[0].scope, 'single-buffer'); assert.equal(plan[0].postQuota, 600);
    assert.equal(allocateConditionBudget(plan[0], plan, [], makeRun(600)).postQuota, 600);
    assert.equal(options.rate, 60); assert.equal(options.batchSize, 10);
  }
  assert.throws(() => parseChainArgs([...args, '--only-buffer', '1500']), /only-buffer/);
  assert.throws(() => parseChainArgs([...args, '--only-buffer', '1000', '--only-buffer', '2000']), /duplicate/);
  assert.throws(() => parseChainArgs([...args, '--only-buffer', '1000', '--max-requests', '801']), /max-requests/);
  assert.throws(() => makePlan(600, 1500), /only-buffer/);
  assert.equal(makePlan(800).length, 12);
});

test('single-buffer completion cannot certify a matrix, another deadline, extra tiers or incomplete sampling', () => {
  const cell = { ...makePlan(600, 1000)[0], status: 'COMPLETE_CONTROLLED_CHAIN' };
  const complete = 'COMPLETE_CONTROLLED_CHAIN_SINGLE_BUFFER_OBSERVATION', incomplete = 'INCOMPLETE_CONTROLLED_CHAIN_SINGLE_BUFFER_BENCHMARK';
  assert.equal(chainCompletionStatus([cell], null, 1000), complete);
  assert.equal(chainCompletionStatus([cell], null), 'INCOMPLETE_CONTROLLED_CHAIN_BENCHMARK');
  assert.equal(chainCompletionStatus([cell], null, 2000), incomplete);
  assert.equal(chainCompletionStatus([{ ...cell, concurrency: 32 }], null, 1000), incomplete);
  assert.equal(chainCompletionStatus([cell, { ...cell, concurrency: 32 }], null, 1000), incomplete);
  assert.equal(chainCompletionStatus([{ ...cell, scope: undefined }], null, 1000), incomplete);
  assert.equal(chainCompletionStatus([{ ...cell, status: 'INCOMPLETE_POST_BUDGET' }], null, 1000), incomplete);
  assert.equal(chainCompletionStatus([cell], { reason: 'total-time-budget' }, 1000), incomplete);
  assert.equal(chainCompletionStatus([], null, 1000), incomplete);
  const independentSingles = [500, 1000, 2000, 3000].map(buffer => ({ ...makePlan(600, buffer)[0], status: 'COMPLETE_CONTROLLED_CHAIN' }));
  assert.equal(chainCompletionStatus(independentSingles, null), 'INCOMPLETE_CONTROLLED_CHAIN_BENCHMARK');
});

function observerCondition(count = 1) {
  const occurrences = makeOccurrences(corpus, 'observer', count, 1000);
  occurrences.forEach(row => Object.assign(row, { schedulerAdmitted: true, receivedAt: 0, displayAt: 100 }));
  return { occurrences, accountingErrors: [], schedulerStats: { received: count, released: 0, translated: 0, original: 0,
    dropped: 0, removed: 0, queued: count, onTimeReady: 0 } };
}

test('a production tick/status clock crossing does not turn a queued occurrence into a drop', () => {
  const condition = observerCondition(); let time = 0, crossDeadlineInStatus = false, releases = 0;
  const clock = { now: () => time, wallNow: () => 1800000000000 + time, setTimeout: () => 0, clearTimeout() {} };
  const scheduler = new LiveScheduler({ settings: { ...settings, liveBufferMs: 100 }, clock, request: async () => [],
    release(event) { releases++; Object.assign(condition.occurrences[0], { outcome: 'original', releasedAt: event.releasedAt,
      releasedTranslated: false, releaseCallbackCount: releases }); return true; },
    status(stats) {
      if (crossDeadlineInStatus) {
        time = 100.01; // tick's cutoff was 99.99; a later status clock has crossed displayAt.
        condition.schedulerStats = stats; reconcileSchedulerOutcomes(condition, time);
      }
    } });
  scheduler.start({ platform: 'youtube', scenario: 'live', resourceId: 'clock', sessionId: 'clock', generation: 1 });
  scheduler.setConnection('connected'); scheduler.setPlayback({ paused: false, seeking: false, contentActive: true, atLiveEdge: true });
  scheduler.ingest([{ id: condition.occurrences[0].id, sourceId: 'clock', originalText: 'おはよう', receivedAt: 0, translatable: false }]);
  time = 99.99; crossDeadlineInStatus = true; scheduler.tick();
  assert.ok(time > condition.occurrences[0].displayAt);
  assert.equal(condition.occurrences[0].outcome, null); assert.equal(condition.dropAttribution.schedulerReportedDrops, 0);
  crossDeadlineInStatus = false; scheduler.tick();
  condition.schedulerStats = scheduler.getStats(); reconcileSchedulerOutcomes(condition, time);
  assert.equal(releases, 1); assert.equal(condition.occurrences[0].outcome, 'original');
  assert.deepEqual(condition.accountingErrors, []); scheduler.dispose();
});

test('drop IDs require a unique counter reconciliation; missing callbacks and true duplicates remain errors', () => {
  const dropped = observerCondition(); dropped.schedulerStats.queued = 0; dropped.schedulerStats.dropped = 1;
  assert.equal(reconcileSchedulerOutcomes(dropped, 1500).confirmedOccurrenceDrops, 1);
  assert.equal(dropped.occurrences[0].outcome, 'drop');
  assert.equal(dropped.occurrences[0].outcomeAtEvidence, 'terminal-observation-time-not-the-unobserved-drop-time');
  const ambiguous = observerCondition(2); ambiguous.schedulerStats.queued = 1; ambiguous.schedulerStats.dropped = 1;
  assert.equal(reconcileSchedulerOutcomes(ambiguous, 1500).unattributedDrops, 1);
  assert.ok(ambiguous.occurrences.every(row => row.outcome === null));
  const missing = observerCondition(2);
  Object.assign(missing.schedulerStats, { queued: 0, dropped: 1, released: 1, original: 1 });
  assert.equal(reconcileSchedulerOutcomes(missing, 1500).confirmedOccurrenceDrops, 0);
  assert.ok(missing.accountingErrors.includes('scheduler-release-count-mismatch'));
  const duplicate = observerCondition();
  Object.assign(duplicate.occurrences[0], { outcome: 'original', releasedAt: 100, releasedTranslated: false, releaseCallbackCount: 2 });
  Object.assign(duplicate.schedulerStats, { queued: 0, released: 1, original: 1 });
  reconcileSchedulerOutcomes(duplicate, 1500);
  assert.ok(duplicate.accountingErrors.includes('duplicate-release-callback'));
  reconcileSchedulerOutcomes(duplicate, 1600);
  assert.ok(duplicate.accountingErrors.includes('duplicate-release-callback'));
});

test('actual JSONL inspection retains metadata and rejects the old object protocol', () => {
  const request = { model: settings.model, thinking: { type: 'disabled' }, stream: false,
    messages: [{ role: 'user', content: '[0,"おはよう"]\n[1,"こんばんは"]' }] };
  const metadata = inspectJsonlRequest(JSON.stringify(request), settings);
  assert.equal(metadata.rows, 2); assert.equal(metadata.protocol, 'jsonl');
  assert.ok(!JSON.stringify(metadata).includes('おはよう'));
  request.messages[0].content = '{"items":[{"id":0,"text":"おはよう"}]}';
  assert.throws(() => inspectJsonlRequest(JSON.stringify(request), settings), /actual-jsonl/);
});

test('failure, missing, stopped and duplicate text occurrences remain in fixed cohort denominators', () => {
  const events = makeOccurrences([corpus[0]], 'test', 2, 4000);
  assert.equal(new Set(events.map(row => row.id)).size, 8);
  Object.assign(events[0], { receivedAt: 0, displayAt: 500, readyAt: 499, validTranslation: true, outputUnicodeChars: 2, outcome: 'translated' });
  Object.assign(events[1], { receivedAt: 500, displayAt: 1000, readyAt: 1000, validTranslation: true, outcome: 'original', releasedTranslated: false });
  events[2].outcome = 'drop'; events[3].outcome = 'removed'; events[4].outcome = 'global-post-budget';
  const summary = summarizeChain({ occurrences: events, attempts: [], feedMs: 4000, concurrency: 16, peakActualConcurrency: 0 });
  assert.equal(summary.denominator, 8); assert.equal(summary.onTimeReadyItems, 1); assert.equal(summary.onTimeCoverage, 1 / 8);
  assert.deepEqual(summary.twoSecondBuckets.map(row => row.denominator), [4, 4]);
  assert.equal(summary.missing, 3); assert.equal(summary.dropped, 1); assert.equal(summary.removed, 1);
  assert.equal(summary.usageAndNominalCost.cost.total, 0); // No actual POST, hence no incurred-attempt ledger.
});

test('actual ready-time buckets include drain, exact 2s boundaries and the measured final partial second', () => {
  const events = makeOccurrences([corpus[0]], 'ready-buckets', 2, 4000);
  [1999, 2000, 4100].forEach((readyAt, index) => Object.assign(events[index], {
    receivedAt: 0, displayAt: 5000, readyAt, validTranslation: true, outputUnicodeChars: 2,
    outcome: 'translated', cached: index === 1, unchangedOutput: index === 2,
  }));
  const summary = summarizeChain({ occurrences: events, attempts: [], feedMs: 4000, durationMs: 4200, concurrency: 16, peakActualConcurrency: 0 });
  assert.deepEqual(summary.readyTimeBuckets.map(row => row.onTimeReadyItems), [1, 1, 1]);
  assert.deepEqual(summary.readyTimeBuckets.map(row => row.durationSeconds), [2, 2, 0.2]);
  assert.equal(summary.readyTimeBuckets[2].onTimeReadyCharsPerSecond, 20 / 2);
  assert.equal(summary.readyTimeBuckets[0].providerChangedItems, 1);
  assert.equal(summary.readyTimeBuckets[1].cacheHitItems, 1);
  assert.equal(summary.readyTimeBuckets[2].unchangedOutputItems, 1);
  assert.equal(summary.twoSecondBuckets[0].onTimeReadyItems, 3); // Arrival cohorts remain a separate view.
});

function stableSaturatedCell() {
  return { concurrency: 16, peakActualConcurrency: 16, status: 'COMPLETE_CONTROLLED_CHAIN', feedMs: 30000,
    attempts: Array.from({ length: 64 }, (_, i) => ({ items: 10, postedAt: i * 20, settledAt: i * 20 + 100, httpStatus: 200, status: 'completed' })),
    samples: Array.from({ length: 8 }, (_, i) => ({ at: i * 50, activePosts: 16, undispatchedUniqueItems: 3 })) };
}

test('escalation needs real saturation plus backlog, stable comparable latency and a complete cell', () => {
  const cell = stableSaturatedCell(); assert.equal(escalationEvidence(cell).eligible, true);
  cell.samples.forEach(row => { row.undispatchedUniqueItems = 0; }); assert.equal(escalationEvidence(cell).eligible, false);
  const slow = stableSaturatedCell(); slow.attempts.slice(32).forEach(row => { row.settledAt += 100; });
  assert.ok(escalationEvidence(slow).reasons.includes('latency-deteriorated'));
  const limited = stableSaturatedCell(); limited.status = 'INCOMPLETE_POST_BUDGET'; assert.equal(escalationEvidence(limited).eligible, false);
  const rateLimited = stableSaturatedCell(); rateLimited.attempts[0].httpStatus = 429; assert.equal(escalationEvidence(rateLimited).eligible, false);
  const sparse = stableSaturatedCell(); sparse.attempts.length = 20; assert.equal(escalationEvidence(sparse).eligible, false);
  const timedOut = stableSaturatedCell(); timedOut.attempts.forEach(row => { row.status = 'timeout'; });
  assert.equal(escalationEvidence(timedOut).eligible, false);
  const slowerStage = stableSaturatedCell(); slowerStage.attempts.forEach(row => { row.settledAt += 30; });
  assert.ok(escalationEvidence(slowerStage, stableSaturatedCell()).reasons.includes('cross-stage-latency-deteriorated'));
});

test('hard POST guard stops before transport and budget-limited observations cannot be complete', () => {
  assert.equal(postBudgetReason({ actualPosts: 800, maxRequests: 800 }, { actualPosts: 0, postQuota: 64 }), 'global-post-budget');
  assert.equal(postBudgetReason(makeRun(800), { actualPosts: 64, postQuota: 64 }), 'condition-post-budget');
  const elapsed = { ...makeRun(800), deadlineAt: 100 };
  assert.equal(postBudgetReason(elapsed, { actualPosts: 0, postQuota: 64 }, 100), 'total-time-budget');
  assert.equal(elapsed.stop.actualPostsAtStop, 0);
  const conditions = [500, 1000, 2000, 3000].map(bufferMs => ({ bufferMs, concurrency: 16, status: 'COMPLETE_CONTROLLED_CHAIN' }));
  assert.equal(chainCompletionStatus(conditions, null), 'COMPLETE_CONTROLLED_CHAIN_OBSERVATION');
  conditions[3].status = 'INCOMPLETE_POST_BUDGET';
  assert.equal(chainCompletionStatus(conditions, null), 'INCOMPLETE_CONTROLLED_CHAIN_BENCHMARK');
});

test('production scheduler/engine accepts per-event results with controlled deadlines and fresh per-cell cache', async () => {
  let posts = 0;
  const transport = async (...args) => { posts++; return reply(...args); };
  const clock = new ControlledClock();
  const run = makeRun(10), options = { corpus: [corpus[0]], settings, apiKey: 'synthetic-never-sent', run, feedMs: 100, rate: 20, transport };
  const first = await runChainCondition({ ...options, clock, pause: ms => clock.advanceBy(ms), cell: { id: 'first', concurrency: 16, bufferMs: 100, postQuota: 5 } });
  assert.equal(first.status, 'COMPLETE_CONTROLLED_CHAIN');
  assert.equal(first.summary.denominator, 2); assert.equal(first.summary.onTimeReadyItems, 2);
  assert.equal(first.summary.localCacheItems, 1); assert.equal(first.actualPosts, 1);
  assert.equal(first.attempts[0].protocol, 'jsonl'); assert.equal(first.attempts[0].usage.promptTokens, 20);
  assert.ok(first.occurrences.every(row => row.readyAt < row.displayAt && row.releasedTranslated));
  const secondClock = new ControlledClock();
  const second = await runChainCondition({ ...options, clock: secondClock, pause: ms => secondClock.advanceBy(ms),
    cell: { id: 'second', scope: 'single-buffer', concurrency: 16, bufferMs: 100, postQuota: 5 } });
  assert.equal(second.actualPosts, 1); assert.equal(posts, 2);
  assert.equal(second.escalation.eligible, false); assert.equal(second.escalation.nextConcurrency, null);
  const serialized = JSON.stringify([first, second]);
  assert.ok(!serialized.includes('synthetic-never-sent') && !serialized.includes('おはよう') && !serialized.includes('你好'));
});

test('unsent budget failures retain raw denominator and only the authorized number of POSTs happen', async () => {
  let posts = 0;
  const clock = new ControlledClock();
  const result = await runChainCondition({ cell: { id: 'budget', concurrency: 16, bufferMs: 100, postQuota: 1 }, corpus, settings,
    apiKey: 'synthetic-never-sent', run: makeRun(1), feedMs: 100, rate: 20, clock, pause: ms => clock.advanceBy(ms),
    transport: async (...args) => { posts++; return reply(...args); } });
  assert.equal(posts, 1); assert.equal(result.actualPosts, 1); assert.equal(result.status, 'INCOMPLETE_POST_BUDGET');
  assert.equal(result.summary.denominator, 2); assert.equal(result.summary.onTimeReadyItems, 1); assert.equal(result.summary.original, 1);
  assert.ok(result.occurrences.every(row => row.outcome !== null)); assert.equal(result.summary.missing, 0);
  assert.equal(result.attempts.filter(row => row.postedAt === null && row.blockedReason === 'global-post-budget').length, 1);
  assert.equal(result.escalation.eligible, false);
});
