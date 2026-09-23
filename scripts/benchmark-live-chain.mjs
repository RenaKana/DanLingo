// Real Provider entry point. Importing this module never reads credentials or starts a request.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveScheduler } from '../src/core/live-scheduler.ts';
import { normalizeSettings, LIVE_PROMPT_VERSION, MAX_CONCURRENCY } from '../src/core/config.ts';
import { TranslationEngine } from '../src/translation/engine.ts';
import { MemoryTranslationCache } from '../src/translation/cache.ts';
import { ProviderError, retryAfterMs } from '../src/translation/provider.ts';
import { readAuthorizedLiveConfig } from './authorized-live-config.mjs';
import { selectCorpus, distribution, unicodeChars } from './benchmark-live-provider.mjs';
import { calculateAttemptCost, summarizeCostReplay } from './translation-cost-metrics.mjs';

export const BUFFERS_MS = [500, 1000, 2000, 3000];
export const FEED_MS = 30000, BUCKET_MS = 2000, SAMPLE_MS = 50;
export const CORPUS_PATH = '.artifacts/live/niconico-extension/real-provider-edge-lv351351036-Fi243O/report.json';
const CONCURRENCIES = [16, 32, 64];
const BASELINE_RESERVES = [256, 288, 128, 128];
const COMPLETE = 'COMPLETE_CONTROLLED_CHAIN';
const hash = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = value => Math.round(value * 1000) / 1000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const check = (condition, code) => { if (!condition) throw new Error(code); };
const safeReason = error => /^[a-z0-9-]{1,80}$/.test(error?.message ?? '') ? error.message : 'benchmark-error';
const batchBucket = size => size <= 1 ? '1' : size <= 5 ? '2-5' : size <= 10 ? '6-10' : size <= 20 ? '11-20' : '21+';

export function parseChainArgs(args) {
  const allowed = new Set(['--config-file', '--test-model', '--test-profile', '--test-thinking', '--rate', '--batch-size', '--max-requests', '--only-buffer']);
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    check(allowed.has(args[i]) && args[i + 1] && !args[i + 1].startsWith('--') && !values.has(args[i]), 'invalid-or-duplicate-argument');
    values.set(args[i], args[i + 1]);
  }
  check(values.get('--config-file'), 'explicit-config-file-required');
  check(values.get('--test-model') === 'deepseek-v4-flash' && values.get('--test-profile') === 'deepseek'
    && values.get('--test-thinking') === 'off', 'explicit-deepseek-v4-flash-deepseek-off-required');
  const rate = Number(values.get('--rate') ?? 60), batchSize = Number(values.get('--batch-size') ?? 10);
  const maxRequests = Number(values.get('--max-requests') ?? 800);
  check(Number.isInteger(rate) && rate >= 1 && rate <= 300, 'rate-must-be-1-to-300');
  check(Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 200, 'batch-size-must-be-1-to-200');
  check(Number.isInteger(maxRequests) && maxRequests >= 4 && maxRequests <= 800, 'max-requests-must-be-4-to-800');
  check(!values.has('--only-buffer') || BUFFERS_MS.map(String).includes(values.get('--only-buffer')), 'only-buffer-must-be-500-1000-2000-or-3000');
  const onlyBuffer = values.has('--only-buffer') ? Number(values.get('--only-buffer')) : undefined;
  return { configFile: values.get('--config-file'), model: 'deepseek-v4-flash', profile: 'deepseek', thinkingEffort: 'off', rate, batchSize, maxRequests, onlyBuffer };
}

/** Reserve the entire cap for C16 first. Higher tiers use only the actual remainder afterward. */
export function makePlan(maxRequests, onlyBuffer) {
  if (onlyBuffer !== undefined) {
    check(BUFFERS_MS.includes(onlyBuffer), 'only-buffer-must-be-500-1000-2000-or-3000');
    return [{ id: `single-b${onlyBuffer}-c16`, scope: 'single-buffer', bufferMs: onlyBuffer, concurrency: 16, postQuota: maxRequests }];
  }
  const quotas = BASELINE_RESERVES.map(weight => Math.max(1, Math.floor(maxRequests * weight / 800)));
  const order = BASELINE_RESERVES.map((weight, index) => ({ index, remainder: maxRequests * weight / 800 - quotas[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let left = maxRequests - quotas.reduce((sum, quota) => sum + quota, 0), index = 0; left > 0; left--, index++) quotas[order[index % 4].index]++;
  return CONCURRENCIES.flatMap(concurrency => BUFFERS_MS.map((bufferMs, index) => ({ id: `b${bufferMs}-c${concurrency}`, bufferMs,
    concurrency, postQuota: concurrency === 16 ? quotas[index] : null })));
}

/** A reserve is a floor for later baselines, not a quota reserved for optional higher tiers. */
export function allocateConditionBudget(cell, plan, conditions, run) {
  const remainingPosts = Math.max(0, run.maxRequests - run.actualPosts);
  if (cell.scope === 'single-buffer') return { eligible: remainingPosts > 0, postQuota: remainingPosts, remainingPosts,
    protectedBaselinePosts: 0, initialReserve: cell.postQuota, basis: 'single-buffer-c16-exclusive-run-budget' };
  if (cell.concurrency === 16) {
    const later = plan.filter(row => row.concurrency === 16 && BUFFERS_MS.indexOf(row.bufferMs) > BUFFERS_MS.indexOf(cell.bufferMs));
    const protectedBaselinePosts = later.reduce((sum, row) => sum + row.postQuota, 0);
    return { eligible: remainingPosts > protectedBaselinePosts, postQuota: Math.max(0, remainingPosts - protectedBaselinePosts),
      remainingPosts, protectedBaselinePosts, initialReserve: cell.postQuota, basis: 'baseline-reserve-plus-unused-earlier-budget' };
  }
  const previous = conditions.find(row => row.bufferMs === cell.bufferMs && row.concurrency === cell.concurrency / 2);
  const baselinesComplete = BUFFERS_MS.every(buffer => conditions.some(row => row.bufferMs === buffer && row.concurrency === 16 && row.status === COMPLETE));
  const minimumPosts = Math.max(2 * cell.concurrency, Math.ceil((previous?.actualPosts ?? 0) * 1.5));
  return { eligible: baselinesComplete && previous?.status === COMPLETE && remainingPosts >= minimumPosts,
    postQuota: remainingPosts, remainingPosts, minimumPosts, baselinesComplete,
    basis: 'all-baselines-complete-and-remaining-at-least-150-percent-of-previous-posts-and-two-capacity-waves' };
}

/** Only final public counter evidence can identify a drop; reading a later clock cannot. */
export function reconcileSchedulerOutcomes(condition, at) {
  const stats = condition.schedulerStats, admitted = condition.occurrences.filter(row => row.schedulerAdmitted);
  const unresolved = admitted.filter(row => row.outcome === null);
  const released = admitted.filter(row => finite(row.releasedAt));
  const removed = admitted.filter(row => row.outcome === 'removed');
  const knownDrops = admitted.filter(row => row.outcome === 'drop');
  const errors = [];
  if (admitted.some(row => (row.releaseCallbackCount ?? 0) > 1)) errors.push('duplicate-release-callback');
  if (stats.received !== admitted.length) errors.push('scheduler-received-count-mismatch');
  if (stats.released !== released.length) errors.push('scheduler-release-count-mismatch');
  if (stats.translated !== released.filter(row => row.releasedTranslated === true).length
    || stats.original !== released.filter(row => row.releasedTranslated === false).length) errors.push('scheduler-release-kind-mismatch');
  if (stats.removed !== removed.length) errors.push('scheduler-removed-count-mismatch');
  if (stats.onTimeReady !== admitted.filter(row => row.validTranslation).length) errors.push('scheduler-ready-count-mismatch');
  if (stats.received !== stats.released + stats.removed + stats.dropped + stats.queued) errors.push('scheduler-total-outcome-mismatch');
  const remainingDrops = stats.dropped - knownDrops.length;
  // With an empty queue, exact released/removed totals and exactly N unaccounted IDs for
  // N reported drops, the entire remaining ID set is uniquely determined. Otherwise it is unknown.
  const uniquelyDetermined = errors.length === 0 && stats.queued === 0 && remainingDrops >= 0 && unresolved.length === remainingDrops;
  if (uniquelyDetermined) for (const row of unresolved) {
    row.outcome = 'drop'; row.outcomeAt = at;
    row.outcomeEvidence = 'final-empty-queue-and-exact-released-removed-drop-counter-reconciliation';
    row.outcomeAtEvidence = 'terminal-observation-time-not-the-unobserved-drop-time';
  }
  const confirmed = admitted.filter(row => row.outcome === 'drop').length;
  condition.dropAttribution = { schedulerReportedDrops: stats.dropped, confirmedOccurrenceDrops: confirmed,
    unattributedDrops: Math.max(0, stats.dropped - confirmed), uniquelyDetermined,
    unresolvedOccurrenceIds: admitted.filter(row => row.outcome === null).map(row => row.id) };
  for (const error of errors) if (!condition.accountingErrors.includes(error)) condition.accountingErrors.push(error);
  return condition.dropAttribution;
}

export function makeOccurrences(corpus, conditionId, rate, feedMs = FEED_MS) {
  return Array.from({ length: Math.floor(rate * feedMs / 1000) }, (_, index) => {
    const source = corpus[index % corpus.length];
    return { id: `${conditionId}:e${index}`, corpusIndex: index % corpus.length, corpusOrdinal: source.ordinal,
      uniqueId: source.textSha256 ?? hash(source.text), inputUnicodeChars: source.unicodeChars ?? unicodeChars(source.text),
      eligible: true, schedulerAdmitted: false, scheduledArrivalAt: index * 1000 / rate, receivedAt: null, displayAt: null,
      engineEnqueuedAt: null, engineOccurrenceId: null, engineTaskId: null, engineReadyAt: null,
      readyAt: null, validTranslation: false, outputUnicodeChars: 0, cached: false, unchangedOutput: false,
      releasedAt: null, releasedTranslated: null, outcome: null, outcomeAt: null, failures: [], relatedAttemptIds: [] };
  });
}

/** Validate the actual production payload in memory; return metadata only. Never persist the body. */
export function inspectJsonlRequest(bodyText, settings) {
  const body = JSON.parse(bodyText);
  check(body.model === settings.model && body.thinking?.type === 'disabled' && body.reasoning_effort === undefined,
    'selected-model-or-thinking-changed');
  check(body.stream === false, 'unexpected-stream-mode');
  const content = body.messages?.find(message => message.role === 'user')?.content;
  check(typeof content === 'string', 'missing-jsonl-user-payload');
  const rows = content.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  check(rows.length > 0 && rows.every(row => Array.isArray(row) && row.length === 2 && Number.isInteger(row[0])
    && typeof row[1] === 'string') && new Set(rows.map(row => row[0])).size === rows.length, 'actual-jsonl-required');
  return { protocol: 'jsonl', rows: rows.length, requestBytes: Buffer.byteLength(bodyText),
    userBytes: Buffer.byteLength(content), sourceBytes: rows.reduce((sum, row) => sum + Buffer.byteLength(row[1]), 0),
    sentModel: body.model, sentThinking: 'disabled-explicit', stream: false };
}

export function postBudgetReason(run, condition, monotonicNow = performance.now()) {
  if (run.stop) return run.stop.reason;
  if (finite(run.deadlineAt) && monotonicNow >= run.deadlineAt) {
    run.stop = { reason: 'total-time-budget', actualPostsAtStop: run.actualPosts };
    return run.stop.reason;
  }
  if (run.actualPosts >= run.maxRequests) return 'global-post-budget';
  if (condition.actualPosts >= condition.postQuota) return 'condition-post-budget';
  return null;
}

function settledPosts(condition) {
  return condition.attempts.filter(row => finite(row.postedAt) && finite(row.settledAt)).sort((a, b) => a.postedAt - b.postedAt);
}

const uncensoredSuccess = row => row.httpStatus >= 200 && row.httpStatus < 300 && row.status === 'completed';

function compareLatencyPopulations(before, after) {
  const buckets = [], total = before.length + after.length;
  const firstValid = before.filter(uncensoredSuccess), lastValid = after.filter(uncensoredSuccess);
  let compared = 0;
  for (const bucket of ['1', '2-5', '6-10', '11-20', '21+']) {
    const first = firstValid.filter(row => batchBucket(row.items) === bucket), last = lastValid.filter(row => batchBucket(row.items) === bucket);
    if (first.length < 8 || last.length < 8) continue;
    const firstP95 = distribution(first.map(row => row.settledAt - row.postedAt)).p95Ms;
    const lastP95 = distribution(last.map(row => row.settledAt - row.postedAt)).p95Ms;
    compared += first.length + last.length;
    buckets.push({ batchSizeBucket: bucket, firstSamples: first.length, lastSamples: last.length,
      firstP95Ms: firstP95, lastP95Ms: lastP95, stable: lastP95 <= firstP95 * 1.2 });
  }
  const firstFailureOrCensorFraction = before.length ? 1 - firstValid.length / before.length : 1;
  const lastFailureOrCensorFraction = after.length ? 1 - lastValid.length / after.length : 1;
  const failureOrCensorFractionNonIncreasing = lastFailureOrCensorFraction <= firstFailureOrCensorFraction;
  const sufficient = firstValid.length >= 20 && lastValid.length >= 20 && compared >= total * 0.8 && buckets.length > 0;
  return { totalSettledPosts: total, comparedPosts: compared, minimumUncensoredSamplesPerPopulation: 20,
    firstFailureOrCensorFraction, lastFailureOrCensorFraction, failureOrCensorFractionNonIncreasing,
    requiredComparableFraction: 0.8, maximumP95Ratio: 1.2, sufficient,
    stable: sufficient && failureOrCensorFractionNonIncreasing && buckets.every(row => row.stable), buckets,
    population: 'complete successful POSTs for latency; failures and deadline-censored POSTs remain in failure fractions and total sample denominator' };
}

/** Fixed deadline timeouts are censored; a plateau of timeouts cannot establish stable latency. */
export function latencyEvidence(condition) {
  const posts = settledPosts(condition), midpoint = Math.floor(posts.length / 2);
  return compareLatencyPopulations(posts.slice(0, midpoint), posts.slice(midpoint));
}

export function escalationEvidence(condition, previous) {
  const samples = condition.samples ?? [];
  let saturatedBacklogMs = 0, saturatedBacklogSamples = 0;
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    if (sample.at >= (condition.feedMs ?? FEED_MS)) continue;
    if (sample.activePosts >= condition.concurrency && sample.undispatchedUniqueItems > 0) {
      saturatedBacklogSamples++;
      // Cap sparse samples; a stalled event loop cannot invent a long period of sustained saturation.
      const until = Math.min(samples[index + 1]?.at ?? sample.at, condition.feedMs ?? FEED_MS);
      saturatedBacklogMs += Math.max(0, Math.min(SAMPLE_MS * 2, until - sample.at));
    }
  }
  const latency = latencyEvidence(condition);
  const previousStageLatency = previous ? compareLatencyPopulations(settledPosts(previous), settledPosts(condition)) : null;
  const badHttp = condition.attempts.some(row => [401, 403, 429].includes(row.httpStatus));
  const reasons = [];
  if (condition.status !== COMPLETE) reasons.push('condition-incomplete');
  if (condition.peakActualConcurrency < condition.concurrency || saturatedBacklogMs < 250 || saturatedBacklogSamples < 3) reasons.push('saturation-with-backlog-not-established');
  if (badHttp) reasons.push('http-401-403-or-429');
  if (!latency.sufficient) reasons.push('insufficient-comparable-latency-samples');
  else if (!latency.stable) reasons.push('latency-deteriorated');
  if (previousStageLatency && !previousStageLatency.sufficient) reasons.push('insufficient-cross-stage-latency-samples');
  else if (previousStageLatency && !previousStageLatency.stable) reasons.push('cross-stage-latency-deteriorated');
  return { eligible: reasons.length === 0, reasons, saturatedBacklogMs: round(saturatedBacklogMs), saturatedBacklogSamples,
    latency, previousStageLatency, nextConcurrency: condition.concurrency < 64 ? condition.concurrency * 2 : null };
}

/** Every planned occurrence remains in this denominator, even when it never reaches the scheduler. */
export function summarizeChain(condition) {
  const events = condition.occurrences, posts = condition.attempts.filter(row => finite(row.postedAt));
  const valid = row => row.validTranslation && finite(row.readyAt) && finite(row.displayAt) && row.readyAt < row.displayAt;
  const rows = events.filter(valid), counts = {};
  for (const row of events) counts[row.outcome ?? 'missing'] = (counts[row.outcome ?? 'missing'] ?? 0) + 1;
  const feedMs = condition.feedMs ?? FEED_MS;
  const buckets = Array.from({ length: Math.ceil(feedMs / BUCKET_MS) }, (_, index) => {
    const from = index * BUCKET_MS, until = Math.min(feedMs, from + BUCKET_MS);
    const cohort = events.filter(row => row.scheduledArrivalAt >= from && row.scheduledArrivalAt < until);
    const ready = cohort.filter(valid), chars = ready.reduce((sum, row) => sum + row.outputUnicodeChars, 0);
    return { fromMs: from, untilMs: until, denominator: cohort.length, onTimeReadyItems: ready.length, onTimeReadyUnicodeChars: chars,
      itemsPerSecond: round(ready.length / ((until - from) / 1000)), charsPerSecond: round(chars / ((until - from) / 1000)),
      coverage: cohort.length ? ready.length / cohort.length : null };
  });
  const readyWindowMs = Math.max(feedMs, condition.durationMs ?? feedMs + (condition.bufferMs ?? 0));
  const readyTimeBuckets = Array.from({ length: Math.ceil(readyWindowMs / BUCKET_MS) }, (_, index) => {
    const from = index * BUCKET_MS, until = Math.min(readyWindowMs, from + BUCKET_MS);
    const ready = rows.filter(row => row.readyAt >= from && row.readyAt < until);
    const changed = ready.filter(row => !row.unchangedOutput), cached = ready.filter(row => row.cached);
    const unchanged = ready.filter(row => row.unchangedOutput), providerChanged = changed.filter(row => !row.cached);
    const chars = subset => subset.reduce((sum, row) => sum + row.outputUnicodeChars, 0);
    const durationSeconds = (until - from) / 1000;
    return { fromMs: from, untilMs: until, durationSeconds,
      onTimeReadyItems: ready.length, onTimeReadyUnicodeChars: chars(ready),
      onTimeReadyItemsPerSecond: round(ready.length / durationSeconds), onTimeReadyCharsPerSecond: round(chars(ready) / durationSeconds),
      changedItems: changed.length, changedUnicodeChars: chars(changed),
      providerChangedItems: providerChanged.length, providerChangedUnicodeChars: chars(providerChanged),
      cacheHitItems: cached.length, cacheHitUnicodeChars: chars(cached),
      unchangedOutputItems: unchanged.length, unchangedOutputUnicodeChars: chars(unchanged) };
  });
  const taskPosts = new Map();
  for (const attempt of posts) for (const taskId of attempt.taskIds) {
    const list = taskPosts.get(taskId) ?? []; list.push(attempt); taskPosts.set(taskId, list);
  }
  const queueDelays = [];
  for (const row of events) {
    const attempts = (taskPosts.get(row.engineTaskId) ?? []).filter(attempt => attempt.postedAt <= (row.engineReadyAt ?? Infinity));
    row.relatedAttemptIds = attempts.map(attempt => attempt.id);
    if (attempts.length && finite(row.engineEnqueuedAt)) {
      row.firstPostAt = attempts[0].postedAt;
      queueDelays.push(Math.max(0, row.firstPostAt - row.engineEnqueuedAt));
    }
  }
  const rates = condition.rates ?? { currency: null };
  const costAttempts = posts.map(attempt => ({ ...attempt, usageComplete: attempt.usageKnown,
    retry: attempt.attempt > 1, formatFailures: /invalid|missing-id|duplicate/.test(attempt.status ?? '') ? 1 : 0 }));
  const cost = summarizeCostReplay({ occurrences: events, attempts: costAttempts, rates });
  return { denominator: events.length, eligibleDenominator: events.filter(row => row.eligible).length,
    arrived: events.filter(row => finite(row.receivedAt)).length, counts,
    onTimeReadyItems: rows.length, onTimeReadyUnicodeChars: rows.reduce((sum, row) => sum + row.outputUnicodeChars, 0),
    onTimeReadyItemsPerFixedSecond: round(rows.length / (feedMs / 1000)),
    onTimeReadyCharsPerFixedSecond: round(rows.reduce((sum, row) => sum + row.outputUnicodeChars, 0) / (feedMs / 1000)),
    onTimeCoverage: events.length ? rows.length / events.length : null,
    unchangedOnTimeItems: rows.filter(row => row.unchangedOutput).length,
    changedOnTimeItems: rows.filter(row => !row.unchangedOutput).length,
    localCacheItems: rows.filter(row => row.cached).length,
    lateResults: events.filter(row => ['translated', 'cached'].includes(row.engineStatus)
      && finite(row.engineReadyAt) && finite(row.displayAt) && row.engineReadyAt >= row.displayAt).length,
    terminalResultsAtOrAfterDeadline: events.filter(row => finite(row.engineReadyAt) && finite(row.displayAt) && row.engineReadyAt >= row.displayAt).length,
    original: events.filter(row => row.releasedTranslated === false).length,
    dropped: condition.schedulerStats?.dropped ?? counts.drop ?? 0,
    attributedDroppedOccurrences: counts.drop ?? 0, unattributedDroppedOccurrences: condition.dropAttribution?.unattributedDrops ?? 0,
    removed: counts.removed ?? 0, missing: counts.missing ?? 0,
    readinessMs: distribution(rows.map(row => row.readyAt - row.receivedAt)),
    readinessPopulation: 'scheduler-accepted on-time results only; all failed/censored occurrences remain in coverage denominator',
    arrivalScheduleLatenessMs: distribution(events.filter(row => finite(row.receivedAt)).map(row => row.receivedAt - row.scheduledArrivalAt)),
    queueToFirstPostMs: distribution(queueDelays), queueDelayPopulation: 'posted occurrences; joins onto an already active request have zero new queue wait',
    unpostedOccurrences: events.filter(row => !row.relatedAttemptIds.length).length,
    requestDurationMsIncludingFailures: distribution(posts.filter(row => finite(row.settledAt)).map(row => row.settledAt - row.postedAt)),
    headerLatencyMs: distribution(posts.filter(row => finite(row.headersAt)).map(row => row.headersAt - row.postedAt)),
    actualPosts: posts.length, peakActualConcurrency: condition.peakActualConcurrency, configuredConcurrency: condition.concurrency,
    capacityLimitEstablished: false, twoSecondBuckets: buckets,
    bucketDefinition: 'fixed planned-arrival cohorts; each cohort retains failures and receives its own full configured deadline',
    readyTimeBuckets, readyWindowMs,
    readyBucketDefinition: 'actual monotonic readyAt windows through the observed drain; 2 seconds except the final partial window. Cache hits may also be changed or unchanged; providerChanged excludes cache hits.',
    usageAndNominalCost: cost,
  };
}

export function chainCompletionStatus(conditions, stop, onlyBuffer) {
  if (onlyBuffer !== undefined) {
    const cell = conditions[0];
    return !stop && BUFFERS_MS.includes(onlyBuffer) && conditions.length === 1 && cell.scope === 'single-buffer'
      && cell.bufferMs === onlyBuffer && cell.concurrency === 16 && cell.status === COMPLETE
      ? 'COMPLETE_CONTROLLED_CHAIN_SINGLE_BUFFER_OBSERVATION' : 'INCOMPLETE_CONTROLLED_CHAIN_SINGLE_BUFFER_BENCHMARK';
  }
  const base = conditions.filter(row => row.concurrency === 16);
  if (stop || conditions.some(row => row.scope === 'single-buffer') || base.length !== 4
    || BUFFERS_MS.some(buffer => !base.some(row => row.bufferMs === buffer && row.status === COMPLETE))
    || conditions.some(row => row.status.startsWith('INCOMPLETE'))) return 'INCOMPLETE_CONTROLLED_CHAIN_BENCHMARK';
  return 'COMPLETE_CONTROLLED_CHAIN_OBSERVATION';
}

/** Dependencies are injectable solely for small synthetic checks; the CLI always uses the real clock and fetch. */
export async function runChainCondition({ cell, corpus, settings, apiKey, run, feedMs = FEED_MS, rate = 60,
  transport = globalThis.fetch.bind(globalThis), clock: suppliedClock, pause = sleep, burst = false, releasePolicy = 'deadline' }) {
  check(typeof burst === 'boolean', 'invalid-burst-option');
  check(['deadline', 'ready-in-order'].includes(releasePolicy), 'invalid-release-policy');
  const started = performance.now();
  const clock = suppliedClock ?? { now: () => performance.now() - started, wallNow: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle) };
  const condition = { ...cell, observerVersion: 2, feedMs, rate, startedAt: new Date().toISOString(), actualPosts: 0,
    peakActualConcurrency: 0, status: 'RUNNING', budgetBlocked: false, accountingErrors: [],
    occurrences: makeOccurrences(corpus, cell.id, rate, feedMs), attempts: [], engineTrace: [], samples: [] };
  condition.arrivalPattern = burst ? 'all-scheduled-at-zero' : 'fixed-rate';
  condition.releasePolicy = releasePolicy;
  if (burst) condition.occurrences.forEach(row => { row.scheduledArrivalAt = 0; });
  const byId = new Map(condition.occurrences.map(row => [row.id, row]));
  const byEngineOccurrence = new Map(), attemptsByBatch = new Map(), taskRows = new Map();
  const pendingRequests = new Set(), waitingTasks = new Set();
  let admissionIds = [], currentAttempt, activePosts = 0, nextArrival = 0, nextSample = 0, releaseSequence = 0;
  const recordError = code => { if (!condition.accountingErrors.includes(code)) condition.accountingErrors.push(code); };
  const finish = (row, outcome, at = clock.now()) => {
    if (row.outcome !== null) { recordError('duplicate-occurrence-outcome'); return; }
    row.outcome = outcome; row.outcomeAt = at;
  };
  const captureResult = output => {
    const row = byId.get(output.id);
    if (!row) { recordError('unknown-result-id'); return; }
    row.engineReadyAt ??= clock.now(); row.engineStatus ??= output.status;
    if (output.reason && !row.failures.includes(output.reason)) row.failures.push(output.reason);
    if ((output.status === 'translated' || output.status === 'cached') && typeof output.text === 'string') {
      row.outputUnicodeChars = unicodeChars(output.text); row.outputSha256 = hash(output.text);
      row.unchangedOutput = output.text === corpus[row.corpusIndex].text;
    }
  };
  const engine = new TranslationEngine({ clock, maxConcurrency: cell.concurrency,
    cache: new MemoryTranslationCache({ now: () => clock.wallNow() }),
    onTrace(trace) {
      condition.engineTrace.push(trace);
      if (trace.type === 'arrival') {
        const id = admissionIds.shift(), row = byId.get(id);
        if (!row) { recordError('engine-arrival-association-missing'); return; }
        row.engineOccurrenceId = trace.occurrenceId; byEngineOccurrence.set(trace.occurrenceId, row);
      } else if (trace.type === 'bind') {
        const row = byEngineOccurrence.get(trace.occurrenceId);
        if (!row) { recordError('engine-bind-association-missing'); return; }
        row.engineTaskId = trace.taskId;
        const rows = taskRows.get(trace.taskId) ?? []; rows.push(row); taskRows.set(trace.taskId, rows);
      } else if (trace.type === 'queued') waitingTasks.add(trace.taskId);
      else if (trace.type === 'ready') {
        const row = byEngineOccurrence.get(trace.occurrenceId);
        if (row?.engineTaskId && taskRows.get(row.engineTaskId)?.every(item => finite(item.engineReadyAt))) waitingTasks.delete(row.engineTaskId);
      } else if (trace.type === 'attempt') {
        trace.taskIds.forEach(id => waitingTasks.delete(id));
        currentAttempt = { id: `${cell.id}:p${trace.batchId}`, batchId: trace.batchId, taskIds: trace.taskIds, items: trace.items,
          attempt: trace.attempt, engineStartedAt: trace.at, postedAt: null, headersAt: null, settledAt: null,
          inputTokenUpperEstimate: trace.inputTokenUpperEstimate, outputTokenEstimate: trace.outputTokenEstimate,
          liveDispatch: trace.liveDispatch, status: 'pending', httpStatus: null, usageKnown: false };
        condition.attempts.push(currentAttempt); attemptsByBatch.set(trace.batchId, currentAttempt);
      } else if (trace.type === 'settled') {
        const attempt = attemptsByBatch.get(trace.batchId);
        if (!attempt) { recordError('engine-settlement-association-missing'); return; }
        Object.assign(attempt, { settledAt: trace.at, status: trace.status, usage: trace.usage, usageKnown: trace.usageKnown,
          duplicateIds: trace.duplicateIds, cost: calculateAttemptCost({ usage: trace.usage, usageComplete: trace.usageKnown }, { currency: null }) });
        if (finite(attempt.postedAt)) activePosts--;
      }
    },
    fetch: async (url, init) => {
      const attempt = currentAttempt;
      try {
        check(url === settings.endpoint && init?.method === 'POST', 'unexpected-provider-destination');
        check(attempt && attempt.postedAt === null && attempt.settledAt === null, 'transport-association-missing');
        Object.assign(attempt, inspectJsonlRequest(init.body, settings));
        check(attempt.rows === attempt.items, 'transport-batch-size-mismatch');
        const reason = postBudgetReason(run, condition);
        if (reason) {
          attempt.blockedReason = reason;
          if (/post-budget$/.test(reason)) condition.budgetBlocked = true;
          throw new ProviderError(reason);
        }
        // This increment is synchronous and immediately precedes the actual POST, including retries.
        attempt.postedAt = clock.now(); condition.actualPosts++; run.actualPosts++; activePosts++;
        condition.peakActualConcurrency = Math.max(condition.peakActualConcurrency, activePosts);
        const response = await transport(url, init);
        attempt.headersAt = clock.now(); attempt.httpStatus = response.status;
        if ([401, 403, 429].includes(response.status)) {
          const retryMs = response.status === 429 ? retryAfterMs(response.headers.get('retry-after'), clock.wallNow()) : undefined;
          attempt.retryAfterMs = retryMs ?? null;
          run.stop ??= { reason: `http-${response.status}`, conditionId: cell.id, at: clock.now(), actualPostsAtStop: run.actualPosts,
            retryAfterMs: retryMs ?? null };
        }
        return response;
      } catch (error) {
        // Let the production Provider classify real transport failures and apply its normal feedback.
        if (finite(attempt?.postedAt)) throw error;
        const reason = safeReason(error);
        if (!(error instanceof ProviderError)) {
          recordError(reason); run.stop ??= { reason, conditionId: cell.id, actualPostsAtStop: run.actualPosts };
        }
        throw error instanceof ProviderError ? error : new ProviderError(reason, false);
      }
    },
  });
  const localSettings = { ...settings, concurrency: cell.concurrency, liveBufferMs: cell.bufferMs };
  const scheduler = new LiveScheduler({ settings: localSettings, clock,
    request(_session, items, signal, onResult) {
      for (const item of items) byId.get(item.id).engineEnqueuedAt ??= clock.now();
      admissionIds = items.map(item => item.id);
      // Preserve the production per-tab admission quota and live deduplication behavior.
      const promise = engine.translate({ resourceId: 'youtube:live:controlled-chain-corpus', settings: localSettings, apiKey,
        mode: 'deadline', quotaScope: cell.id, signal,
        items: items.map(item => ({ id: item.id, text: item.text, deadlineAt: clock.now() + item.remainingMs })),
        onResult: output => { captureResult(output); onResult(output); } }).then(response => {
          response.items.forEach(captureResult); return response.items;
        });
      pendingRequests.add(promise); void promise.then(() => pendingRequests.delete(promise), () => pendingRequests.delete(promise));
      return promise;
    },
    prepare(event) {
      const row = byId.get(event.source.id);
      row.readyAt ??= event.preparedAt; row.validTranslation = true; row.cached = event.cached;
      if (event.displayAt !== row.displayAt) recordError('display-deadline-drift');
    },
    release(event) {
      const row = byId.get(event.source.id);
      row.releaseCallbackCount = (row.releaseCallbackCount ?? 0) + 1;
      row.releaseSequence ??= releaseSequence++;
      if (row.releaseCallbackCount > 1) recordError('duplicate-release-callback');
      row.releasedAt ??= event.releasedAt; row.releasedTranslated ??= event.translated;
      if (event.displayAt !== row.displayAt) recordError('display-deadline-drift');
      finish(row, event.translated ? 'translated' : 'original', event.releasedAt);
      return true; // A measured scheduler callback, with no browser/native renderer or lane-capacity claim.
    },
    remove(ids) { for (const id of ids) { const row = byId.get(id); if (row && row.outcome === null) finish(row, 'removed'); } },
  });
  scheduler.start({ platform: 'youtube', scenario: 'live', resourceId: 'controlled-chain-corpus', sessionId: cell.id, generation: 1 });
  scheduler.setPresentation({ releasePolicy, active: true });
  scheduler.setConnection('connected'); scheduler.setPlayback({ paused: false, seeking: false, contentActive: true, atLiveEdge: true });
  const endAt = feedMs + cell.bufferMs + 500;
  try {
    while (clock.now() < endAt) {
      const time = clock.now();
      while (nextArrival < condition.occurrences.length && condition.occurrences[nextArrival].scheduledArrivalAt <= time) {
        const row = condition.occurrences[nextArrival++];
        if (time >= feedMs || run.stop) { finish(row, run.stop?.reason ?? 'arrival-window-ended'); continue; }
        row.receivedAt = clock.now(); row.displayAt = row.receivedAt + cell.bufferMs;
        const before = scheduler.getStats();
        scheduler.ingest([{ id: row.id, sourceId: row.id, originalText: corpus[row.corpusIndex].text,
          receivedAt: row.receivedAt, translatable: true }]);
        const after = scheduler.getStats();
        row.schedulerAdmitted = after.received === before.received + 1;
        if (after.received !== before.received + 1) { recordError('scheduler-admission-missing'); if (row.outcome === null) finish(row, 'missing'); }
      }
      if (time >= nextSample) {
        const stats = engine.stats();
        condition.samples.push({ at: time, activePosts, activeEngineRequests: stats.activeRequests,
          queuedUniqueItems: stats.queuedItems, undispatchedUniqueItems: waitingTasks.size,
          pendingUniqueItems: stats.pendingItems, schedulerQueued: scheduler.getStats().queued });
        nextSample = time + SAMPLE_MS;
      }
      if (run.stop?.reason === 'interrupted' || run.stop?.reason === 'total-time-budget') break;
      if (time >= feedMs && scheduler.getStats().queued === 0 && engine.stats().activeRequests === 0 && pendingRequests.size === 0) break;
      const arrival = condition.occurrences[nextArrival]?.scheduledArrivalAt ?? endAt;
      await pause(Math.max(1, Math.min(10, nextSample - clock.now(), arrival - clock.now(), endAt - clock.now())));
    }
  } catch (error) { condition.error = safeReason(error); }
  finally {
    condition.schedulerStats = scheduler.getStats();
    scheduler.dispose(); engine.dispose();
    await Promise.allSettled([...pendingRequests]); await new Promise(resolve => setImmediate(resolve));
    condition.engineStats = engine.stats(); condition.cacheStats = await engine.cache.stats();
    reconcileSchedulerOutcomes(condition, clock.now());
    for (const row of condition.occurrences) if (row.outcome === null) finish(row, run.stop?.reason ?? (condition.error ? 'runner-error' : 'missing'));
    if (activePosts !== 0 || condition.engineStats.activeRequests !== 0) recordError('unsettled-post-at-finalization');
    if (condition.peakActualConcurrency > cell.concurrency) recordError('actual-concurrency-overflow');
    if (condition.actualPosts !== condition.attempts.filter(row => finite(row.postedAt)).length) recordError('post-count-mismatch');
    condition.finishedAt = new Date().toISOString(); condition.durationMs = clock.now();
    condition.summary = summarizeChain(condition);
    condition.status = condition.error || condition.accountingErrors.length || condition.summary.missing ? 'INCOMPLETE_ACCOUNTING'
      : condition.budgetBlocked ? 'INCOMPLETE_POST_BUDGET' : run.stop ? 'INCOMPLETE_STOPPED' : COMPLETE;
    condition.escalation = cell.scope === 'single-buffer'
      ? { eligible: false, reasons: ['single-buffer-c16-scope-no-higher-tiers'], nextConcurrency: null }
      : escalationEvidence(condition);
  }
  return condition;
}

export async function main(args) {
  if (args.includes('--help')) {
    console.log('node --experimental-strip-types scripts/benchmark-live-chain.mjs --config-file PATH --test-model deepseek-v4-flash --test-profile deepseek --test-thinking off [--rate 60] [--batch-size 10] [--max-requests 800] [--only-buffer 500|1000|2000|3000]\nDefault: four independent buffers, each 30s. All budget initially protects C16 (256/288/128/128 at 800), carrying unused budget forward. Gated C32/C64 use only a sufficient remainder after all four baselines complete. --only-buffer: one independent C16 condition for the full 30s, with the entire requested POST budget and no higher tiers; its completion is not matrix or C32/C64 acceptance. Max 800 actual POSTs including retries, 450s total limit. Fresh memory cache per cell; production quotas retained. Only the explicit authorized destination is used. Reports contain hashes/metadata, never source/output text, credentials or headers.');
    return;
  }
  const options = parseChainArgs(args);
  check(MAX_CONCURRENCY >= (options.onlyBuffer === undefined ? 64 : 16), 'production-cap-does-not-support-selected-scope');
  const authorized = await readAuthorizedLiveConfig(options.configFile).catch(() => { throw new Error('authorized-config-invalid'); });
  const settings = normalizeSettings({ ...authorized.settings, enabled: true, displayMode: 'translated',
    model: options.model, profile: options.profile, thinkingEffort: options.thinkingEffort, sourceLanguage: 'auto', liveSourceLanguage: 'auto',
    targetLanguage: 'zh-Hans', batchSize: options.batchSize, translationStream: false });
  check(settings.endpoint === authorized.settings.endpoint && settings.model === options.model && settings.profile === options.profile
    && settings.thinkingEffort === options.thinkingEffort, 'authorized-settings-not-preserved');
  const rawCorpus = await readFile(CORPUS_PATH, 'utf8'), corpus = selectCorpus(JSON.parse(rawCorpus).observation?.events, settings.liveSourceLanguage, settings.targetLanguage);
  const base = resolve('.artifacts/live/provider-chain-benchmark'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, options.onlyBuffer === undefined ? 'deepseek-v4-flash-off-' : `deepseek-v4-flash-off-single-b${options.onlyBuffer}-c16-`));
  const endpoint = new URL(settings.endpoint);
  const sourceHashes = {};
  for (const name of ['src/core/live-scheduler.ts', 'src/core/config.ts', 'src/translation/engine.ts', 'src/translation/provider.ts',
    'src/translation/cache.ts', 'src/translation/clock.ts', 'src/translation/telemetry.ts', 'scripts/benchmark-live-chain.mjs', 'scripts/translation-cost-metrics.mjs']) {
    sourceHashes[name] = hash(await readFile(name));
  }
  const plan = makePlan(options.maxRequests, options.onlyBuffer);
  const scope = options.onlyBuffer === undefined
    ? { mode: 'matrix', buffersMs: BUFFERS_MS, allowedConcurrencyCaps: CONCURRENCIES }
    : { mode: 'single-buffer', buffersMs: [options.onlyBuffer], allowedConcurrencyCaps: [16],
      acceptance: 'Independent single-buffer C16 observation only; not four-buffer matrix or C32/C64 acceptance.' };
  const report = { schemaVersion: 2, status: 'RUNNING', capturedAt: new Date().toISOString(), sourceHashes,
    scope,
    observer: { version: 2, correction: 'Removed deadline-based drop inference from status observations; tick and status can straddle a deadline.',
      dropAttribution: 'Only exact final public counter reconciliation with an empty queue identifies the remaining dropped IDs. Otherwise drops remain unattributed and unresolved occurrences remain explicit.' },
    evidence: 'REAL_PROVIDER_PRODUCTION_ENGINE_SCHEDULER_CONTROLLED_RECORDED_CORPUS_REPLAY',
    selected: { endpoint: endpoint.origin + endpoint.pathname, model: settings.model, profile: settings.profile, thinkingEffort: settings.thinkingEffort,
      sourceLanguage: settings.sourceLanguage, liveSourceLanguage: settings.liveSourceLanguage, targetLanguage: settings.targetLanguage,
      promptVersion: LIVE_PROMPT_VERSION, batchSize: settings.batchSize, translationStream: settings.translationStream,
      liveAdaptiveConcurrency: settings.liveAdaptiveConcurrency, liveMaxBatchWaitMs: settings.liveMaxBatchWaitMs,
      liveMaxInputTokens: settings.liveMaxInputTokens, liveMaxOutputTokens: settings.liveMaxOutputTokens, maxBatchChars: settings.maxBatchChars },
    corpus: { path: resolve(CORPUS_PATH), sha256: hash(rawCorpus), selectedOrderSha256: hash(JSON.stringify(corpus.items.map(row => row.textSha256))),
      recordedOccurrences: corpus.totalRecorded, selectedOccurrences: corpus.items.length, excluded: corpus.excluded,
      uniqueSelectedTexts: new Set(corpus.items.map(row => row.textSha256)).size },
    load: { feedMs: FEED_MS, rate: options.rate, deadlinesMs: scope.buffersMs, maxActualPosts: options.maxRequests, plan,
      replay: 'Cycle the selected recorded order at a fixed controlled rate, with independent occurrence IDs and unchanged text. Original platform arrival times are not replayed.',
      budget: options.onlyBuffer !== undefined
        ? 'The entire requested budget belongs to one independent C16 condition for the full 30 seconds at the selected input rate. No C32/C64 stages. Production cache/quota behavior and the 800 POST/450s hard caps remain unchanged. Budget-blocked work remains INCOMPLETE.'
        : 'All budget initially protects four C16 baselines: 256/288/128/128 at maxRequests=800, with unused earlier budget carried forward while protecting later reserves. C32/C64 start only after all baselines complete, the evidence gate passes, and the remainder covers both 150% of previous full-condition POSTs and two waves at the new concurrency. Otherwise NOT_EXERCISED_BUDGET. No rate/window/sample reduction; an executed cell blocked by budget remains INCOMPLETE.' },
    cache: { local: 'empty new MemoryTranslationCache per cell; normal deduplication and reuse inside that cell', remote: 'uncontrolled and unknown' },
    limits: ['Production LiveScheduler and TranslationEngine public entry points run with one real monotonic clock; no IPC/browser/native renderer latency is measured.',
      'prepare is an on-time scheduler acceptance; release is an always-accepted harness callback, not actual platform display. Renderer drops/removals are not exercised.',
      'Production per-tab quotas (1200 new texts/60000 characters per 60s), batching, adaptive control and live fallback remain enabled. Configured concurrency is a ceiling, not capacity proof.',
      'Provider wire protocol is verified from the actual request JSONL. No source text, output text, keys, headers, raw bodies or reasoning content is saved.',
      'Ready counts follow production acceptance and separately disclose unchanged outputs; semantic translation quality is unverified.',
      'Provider usage is captured once per posted attempt, including failures. No prices are inferred; nominal cost remains unknown without verified rates. Usage is not an invoice.',
      'Local POST lifetimes include response parsing, failure and cancellation. Local cancellation does not prove remote computation or billing stopped.',
      options.onlyBuffer !== undefined
        ? 'This independent single-buffer run executes C16 only. Its completion establishes neither the four-buffer matrix nor C32/C64 acceptance.'
        : 'High concurrency gates use conservative finite-sample observations, not statistical capacity certification. Higher tiers have no advance POST reservation and may all remain unexercised.'],
    conditions: [] };
  const run = { maxRequests: options.maxRequests, actualPosts: 0, stop: null, deadlineAt: performance.now() + 450000 };
  const interrupt = () => { run.stop ??= { reason: 'interrupted', actualPostsAtStop: run.actualPosts }; };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const watchdog = setTimeout(() => { run.stop ??= { reason: 'total-time-budget', actualPostsAtStop: run.actualPosts }; }, 450000);
  const reportPath = resolve(root, 'report.json');
  try {
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    for (const cell of plan) {
      const previous = report.conditions.find(row => row.bufferMs === cell.bufferMs && row.concurrency === cell.concurrency / 2);
      const allocation = allocateConditionBudget(cell, plan, report.conditions, run);
      if (cell.concurrency > 16 && (!previous?.escalation?.eligible || !allocation.baselinesComplete)) {
        report.conditions.push({ ...cell, status: 'NOT_EXERCISED_GATE', gate: { ...previous?.escalation, eligible: false,
          reasons: [...(previous?.escalation?.reasons ?? ['previous-cell-not-exercised']), ...(!allocation.baselinesComplete ? ['baselines-not-complete'] : [])] } });
      } else if (cell.concurrency > 16 && !allocation.eligible && !run.stop) {
        report.conditions.push({ ...cell, status: 'NOT_EXERCISED_BUDGET', budgetAllocation: allocation });
      } else if (run.stop || allocation.postQuota === 0) {
        const reason = run.stop?.reason ?? 'no-reserved-post-budget';
        const skipped = { ...cell, status: 'INCOMPLETE_NOT_RUN', reason, actualPosts: 0, peakActualConcurrency: 0,
          accountingErrors: [], attempts: [], occurrences: makeOccurrences(corpus.items, cell.id, options.rate) };
        skipped.occurrences.forEach(row => { row.outcome = `not-run-${reason}`; });
        skipped.summary = summarizeChain(skipped); report.conditions.push(skipped);
      } else {
        const allocatedCell = { ...cell, postQuota: allocation.postQuota, budgetAllocation: allocation };
        console.log(JSON.stringify({ condition: cell.id, status: 'STARTED', bufferMs: cell.bufferMs, concurrency: cell.concurrency, postQuota: allocation.postQuota }));
        const condition = await runChainCondition({ cell: allocatedCell, corpus: corpus.items, settings, apiKey: authorized.apiKey, run, rate: options.rate });
        if (previous?.attempts) condition.escalation = escalationEvidence(condition, previous);
        report.conditions.push(condition);
        console.log(JSON.stringify({ condition: cell.id, status: condition.status, actualPosts: condition.actualPosts,
          onTimeReadyItems: condition.summary.onTimeReadyItems, denominator: condition.summary.denominator,
          peakActualConcurrency: condition.peakActualConcurrency, escalation: condition.escalation }));
      }
      report.actualPosts = run.actualPosts; report.stop = run.stop;
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    }
    report.status = chainCompletionStatus(report.conditions, run.stop, options.onlyBuffer);
  } catch (error) { report.status = 'INCOMPLETE_RUNNER_ERROR'; report.error = safeReason(error); }
  finally {
    clearTimeout(watchdog); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); authorized.apiKey = '';
    report.actualPosts = run.actualPosts; report.stop = run.stop; report.finishedAt = new Date().toISOString();
    report.checks = { postBudgetRespected: run.actualPosts <= options.maxRequests,
      noPostsAfterStop: !run.stop || run.actualPosts === run.stop.actualPostsAtStop,
      executedConditionsAccounted: report.conditions.filter(row => row.occurrences).every(row => row.occurrences.every(event => event.outcome !== null)
        && row.accountingErrors.length === 0),
      actualConcurrencyWithinCellCaps: report.conditions.filter(row => row.occurrences).every(row => row.peakActualConcurrency <= row.concurrency) };
    if (!Object.values(report.checks).every(Boolean)) report.status = 'INCOMPLETE_ACCOUNTING';
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ report: reportPath, status: report.status, actualPosts: report.actualPosts }));
  const completeStatus = options.onlyBuffer === undefined ? 'COMPLETE_CONTROLLED_CHAIN_OBSERVATION' : 'COMPLETE_CONTROLLED_CHAIN_SINGLE_BUFFER_OBSERVATION';
  if (report.status !== completeStatus) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ status: 'INCOMPLETE_BENCHMARK', error: safeReason(error) })); process.exitCode = 1; });
}
