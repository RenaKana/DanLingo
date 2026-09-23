// Controlled replay load against an explicitly authorized Provider. This is not live/browser acceptance.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatCompletionsProvider, ProviderError, retryAfterMs } from '../src/translation/provider.ts';
import { protectText } from '../src/translation/text.ts';
import { needsTranslation } from '../src/core/messages.ts';
import { completionEndpoint, normalizeSettings, PROMPT_VERSION } from '../src/core/config.ts';
import { readAuthorizedLiveConfig } from './authorized-live-config.mjs';

export const FEED_MS = 30000, DRAIN_MS = 3000, DEADLINES_MS = [500, 1000, 2000, 3000], CONCURRENCIES = [2, 4, 8, 16];
const CORPUS_PATH = '.artifacts/live/niconico-extension/real-provider-edge-lv351351036-Fi243O/report.json';
const hash = text => createHash('sha256').update(text).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class BenchmarkError extends Error { constructor(code) { super(code); this.code = code; } }
function check(condition, code) { if (!condition) throw new BenchmarkError(code); }
const safeReason = error => error instanceof ProviderError && /^[a-z0-9-]{1,80}$/.test(error.message) ? error.message
  : error instanceof BenchmarkError ? error.code : 'benchmark-error';
const round = value => Math.round(value * 1000) / 1000;
export const unicodeChars = text => [...text].length;

export function benchmarkCompletionStatus({ deadlineExceeded, stop, tiers }) {
  if (deadlineExceeded || tiers.some(tier => tier.status === 'INCOMPLETE_TOTAL_TIME_BUDGET')) return 'INCOMPLETE_TOTAL_TIME_BUDGET';
  if (stop) return 'STOPPED_NEW_REQUESTS';
  const completedStatuses = new Set(['COMPLETE_CONTROLLED_LOAD', 'COMPLETE_WITH_POST_BUDGET_LIMIT']);
  if (tiers.length !== CONCURRENCIES.length || CONCURRENCIES.some((concurrency, index) => tiers[index]?.concurrency !== concurrency)
    || tiers.some(tier => !completedStatuses.has(tier.status))) return 'INCOMPLETE_BENCHMARK';
  return 'COMPLETE_CONTROLLED_PROVIDER_BENCHMARK';
}

export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const quantile = p => sorted.length ? round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]) : null;
  return { samples: sorted.length, p50Ms: quantile(0.5), p95Ms: quantile(0.95),
    maxMs: sorted.length ? round(sorted.at(-1)) : null };
}

export function selectCorpus(events, sourceLanguage = 'ja', targetLanguage = 'zh-Hans') {
  check(Array.isArray(events), 'recorded-events-missing');
  const excluded = {}, items = [];
  for (const [ordinal, event] of events.entries()) {
    const text = event?.originalText;
    const reason = typeof text !== 'string' || !text || text.length > 1000 ? 'invalid-source'
      : event.translatable !== true ? 'not-translatable'
        : !needsTranslation(text, targetLanguage, sourceLanguage) ? 'no-translation-needed'
          : protectText(text).reason ? 'unsupported-emoticon' : null;
    if (reason) { excluded[reason] = (excluded[reason] || 0) + 1; continue; }
    items.push({ ordinal, text, textSha256: hash(text), unicodeChars: unicodeChars(text),
      sourceId: typeof event.sourceId === 'string' ? event.sourceId.slice(0, 400) : null });
  }
  check(items.length > 0, 'eligible-recorded-corpus-empty');
  return { items, excluded, totalRecorded: events.length };
}

export function makeFeed(corpus, tierId, rate, feedMs = FEED_MS) {
  return Array.from({ length: Math.floor(rate * feedMs / 1000) }, (_, index) => ({
    id: `${tierId}-event-${index + 1}`, corpusIndex: index % corpus.length, sequence: index,
    inputUnicodeChars: corpus[index % corpus.length].unicodeChars,
    scheduledArrivalAtMs: index * 1000 / rate, arrivedAtMs: null, deadlineAtMs: null,
    dispatchedAtMs: null, returnedAtMs: null, completedAtMs: null, requestId: null,
    validOutputChars: 0, protocolValidOutputChars: 0, unchangedOutput: false, completionReason: null,
  }));
}

export function summarizeTier(tier) {
  const { events, requests } = tier;
  const arrived = events.filter(event => event.arrivedAtMs !== null);
  const counts = {};
  for (const event of events) counts[event.completionReason || 'unfinished'] = (counts[event.completionReason || 'unfinished'] || 0) + 1;
  const deadlines = DEADLINES_MS.map(deadlineMs => {
    const valid = events.filter(event => event.validOutputChars > 0 && event.arrivedAtMs !== null
      && event.returnedAtMs !== null && event.returnedAtMs - event.arrivedAtMs <= deadlineMs);
    const chars = valid.reduce((total, event) => total + event.validOutputChars, 0);
    return { deadlineMs, validItems: valid.length, unicodeChars: chars, itemsPerSecond: round(valid.length / (FEED_MS / 1000)),
      charsPerSecond: round(chars / (FEED_MS / 1000)), successRate: events.length ? valid.length / events.length : null,
      denominator: events.length };
  });
  const transitions = requests.filter(request => request.postedAtMs !== null).flatMap(request => [
    { at: request.postedAtMs, delta: 1 }, { at: request.completedAtMs ?? FEED_MS + DRAIN_MS, delta: -1 },
  ]).sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0, peakActualConcurrency = 0, saturatedMs = 0, lastAt = 0;
  for (const transition of transitions) {
    if (active >= tier.concurrency) saturatedMs += Math.max(0, Math.min(FEED_MS, transition.at) - Math.min(FEED_MS, lastAt));
    active += transition.delta; peakActualConcurrency = Math.max(peakActualConcurrency, active); lastAt = transition.at;
  }
  return { denominator: events.length, arrivedItems: arrived.length, plannedInputItemsPerSecond: tier.rate,
    actualArrivalsPerFixedSecond: round(arrived.length / (FEED_MS / 1000)),
    actualInputUnicodeCharsPerFixedSecond: round(arrived.reduce((sum, event) => sum + event.inputUnicodeChars, 0) / (FEED_MS / 1000)),
    arrivalScheduleLateness: distribution(arrived.map(event => event.arrivedAtMs - event.scheduledArrivalAtMs)),
    counts, deadlines, peakActualConcurrency, configuredConcurrency: tier.concurrency,
    secondsAtConfiguredConcurrencyDuringFeed: round(saturatedMs / 1000),
    configuredConcurrencyReached: peakActualConcurrency >= tier.concurrency,
    capacityLimitEstablished: false,
    totalProtocolValidItems: events.filter(event => event.protocolValidOutputChars > 0).length,
    unchangedOutputItems: events.filter(event => event.unchangedOutput).length,
    validThroughputOverFeedAndDrain: { itemsPerSecond: round(deadlines.at(-1).validItems / ((FEED_MS + DRAIN_MS) / 1000)),
      charsPerSecond: round(deadlines.at(-1).unicodeChars / ((FEED_MS + DRAIN_MS) / 1000)) },
    queueWait: distribution(arrived.map(event => (event.dispatchedAtMs ?? event.completedAtMs) - event.arrivedAtMs)),
    httpAttemptDurationIncludingTimeouts: distribution(requests.filter(request => request.postedAtMs !== null)
      .map(request => request.completedAtMs - request.postedAtMs)),
    providerCompletionDuration: distribution(requests.map(request => request.completedAtMs - request.dispatchedAtMs)),
    actualPosts: requests.filter(request => request.postedAtMs !== null).length,
    postedBatchItemCounts: requests.filter(request => request.postedAtMs !== null).map(request => request.itemIds.length),
    budgetLimited: counts['tier-post-budget'] > 0 || counts['global-post-budget'] > 0,
  };
}

async function runTier({ tierId, concurrency, rate, batchSize, postQuota, corpus, settings, apiKey, run }) {
  const started = performance.now(), now = () => performance.now() - started;
  const tier = { tierId, concurrency, rate, batchSize, postQuota, startedAt: new Date().toISOString(),
    localTimeOriginEpochMs: Date.now() - now(),
    feedMs: FEED_MS, drainMs: DRAIN_MS, events: makeFeed(corpus, tierId, rate), requests: [], status: 'running' };
  run.report.tiers.push(tier);
  const queue = [], pending = new Set(), controller = new AbortController();
  let nextArrival = 0, posted = 0;
  const finish = (event, reason, at = now()) => { if (event.completionReason === null) { event.completedAtMs = at; event.completionReason = reason; } };
  const startRequest = batch => {
    const dispatchedAtMs = now(), budgetMs = Math.floor(Math.min(...batch.map(event => event.deadlineAtMs - dispatchedAtMs)));
    if (budgetMs <= 0) { for (const event of batch) finish(event, 'expired-before-dispatch'); return; }
    const request = { id: `${tierId}-request-${tier.requests.length + 1}`, itemIds: batch.map(event => event.id),
      dispatchedAtMs, postedAtMs: null, headersReceivedAtMs: null, completedAtMs: null, budgetMs,
      earliestMessageDeadlineAtMs: Math.min(...batch.map(event => event.deadlineAtMs)), status: null, reason: null };
    tier.requests.push(request);
    for (const event of batch) { event.dispatchedAtMs = dispatchedAtMs; event.requestId = request.id; }
    const provider = new ChatCompletionsProvider({ fetch: async (url, init) => {
      check(url === settings.endpoint && init?.method === 'POST', 'unexpected-provider-request');
      if (run.stop) throw new BenchmarkError(run.stop.reason);
      if (run.actualPosts >= run.maxRequests) throw new BenchmarkError('global-post-budget');
      if (posted >= postQuota) throw new BenchmarkError('tier-post-budget');
      // Inspect only selected request metadata. Never read/store headers or persist the request body.
      const body = JSON.parse(init.body);
      const selectedThinking = settings.thinkingEffort === 'off' ? body.thinking?.type === 'disabled' : body.thinking === undefined;
      check(body.model === 'deepseek-flash' && selectedThinking && body.reasoning_effort === undefined, 'selected-model-or-thinking-changed');
      request.sentModel = body.model; request.sentThinking = settings.thinkingEffort === 'off' ? 'disabled-explicit' : 'service-default-no-override';
      check(now() < request.earliestMessageDeadlineAtMs, 'expired-before-post');
      request.postedAtMs = now(); posted++; run.actualPosts++;
      const response = await globalThis.fetch(url, init);
      request.headersReceivedAtMs = now(); request.status = response.status;
      if (response.status === 401 || response.status === 429) {
        const retryMs = response.status === 429 ? retryAfterMs(response.headers.get('retry-after'), Date.now()) : undefined;
        request.retryAfterMs = retryMs ?? null;
        if (!run.stop) run.stop = { reason: `http-${response.status}`, observedAt: Date.now(), tierId, atTierMs: now(), actualPostsAtStop: run.actualPosts,
          retryAfterMs: retryMs ?? null, retryNotBeforeAt: retryMs === undefined ? null : Date.now() + retryMs };
      }
      return response;
    } });
    const attemptDeadline = new AbortController();
    const deadlineTimer = setTimeout(() => attemptDeadline.abort(), Math.max(0, Math.floor(request.earliestMessageDeadlineAtMs - now())));
    const task = (async () => {
      try {
        const output = await provider.complete({ settings, apiKey, items: batch.map(event => ({ id: event.id, text: corpus[event.corpusIndex].text })),
          budgetMs, mode: 'deadline', signal: AbortSignal.any([controller.signal, attemptDeadline.signal]) });
        const returnedAtMs = now(); request.completedAtMs = returnedAtMs;
        for (const event of batch) {
          event.returnedAtMs = returnedAtMs;
          const item = output.items.get(event.id), text = item?.text;
          if (typeof text === 'string' && text.trim() && !item.reason) {
            event.protocolValidOutputChars = unicodeChars(text);
            event.unchangedOutput = text === corpus[event.corpusIndex].text;
            if (returnedAtMs <= request.earliestMessageDeadlineAtMs && returnedAtMs <= event.deadlineAtMs && !event.unchangedOutput) {
              event.validOutputChars = event.protocolValidOutputChars; event.outputSha256 = hash(text);
              finish(event, 'valid-output', returnedAtMs);
            } else finish(event, event.unchangedOutput ? 'unchanged-output' : 'returned-after-deadline', returnedAtMs);
          } else finish(event, /^[a-z0-9-]{1,80}$/.test(item?.reason || '') ? item.reason : 'invalid-output', returnedAtMs);
        }
        request.reason = 'completed';
      } catch (error) {
        const returnedAtMs = now(); request.completedAtMs = returnedAtMs;
        request.reason = attemptDeadline.signal.aborted ? 'deadline-timeout' : safeReason(error);
        if (error instanceof ProviderError && error.status) request.status = error.status;
        for (const event of batch) { event.returnedAtMs = returnedAtMs; finish(event, request.reason, returnedAtMs); }
      } finally { clearTimeout(deadlineTimer); request.completedAtMs ??= now(); }
    })();
    pending.add(task); void task.finally(() => pending.delete(task));
  };
  console.log(JSON.stringify({ tier: tierId, state: 'started', concurrency, batchSize, inputItemsPerSecond: rate, postQuota }));
  const watchdog = setTimeout(() => controller.abort(), FEED_MS + DRAIN_MS);
  try {
    while (now() < FEED_MS + DRAIN_MS && !run.deadlineExceeded) {
      const time = now();
      if (time < FEED_MS) {
        while (nextArrival < tier.events.length && tier.events[nextArrival].scheduledArrivalAtMs <= time) {
          const event = tier.events[nextArrival++], arrivedAtMs = now();
          if (arrivedAtMs >= FEED_MS) { finish(event, 'input-window-ended-before-arrival'); continue; }
          event.arrivedAtMs = arrivedAtMs; event.deadlineAtMs = arrivedAtMs + DRAIN_MS;
          if (run.stop) finish(event, run.stop.reason);
          else if (posted >= postQuota) finish(event, 'tier-post-budget');
          else queue.push(event);
        }
      } else while (nextArrival < tier.events.length) finish(tier.events[nextArrival++], 'input-window-ended-before-arrival');
      while (queue.length && queue[0].deadlineAtMs <= now()) finish(queue.shift(), 'expired-in-queue');
      if (run.stop || posted >= postQuota || run.actualPosts >= run.maxRequests) {
        const reason = run.stop?.reason || (posted >= postQuota ? 'tier-post-budget' : 'global-post-budget');
        while (queue.length) finish(queue.shift(), reason);
      } else while (pending.size < concurrency && posted < postQuota && !run.stop
        && (queue.length >= batchSize || time >= FEED_MS && queue.length > 0)) {
        while (queue.length && queue[0].deadlineAtMs <= now()) finish(queue.shift(), 'expired-in-queue');
        if (queue.length < batchSize && time < FEED_MS || !queue.length) break;
        startRequest(queue.splice(0, batchSize));
      }
      const next = nextArrival < tier.events.length ? tier.events[nextArrival].scheduledArrivalAtMs : FEED_MS + DRAIN_MS;
      await sleep(Math.max(1, Math.min(5, next - now(), FEED_MS + DRAIN_MS - now())));
    }
  } finally {
    clearTimeout(watchdog); controller.abort();
    await Promise.allSettled([...pending]);
    for (const event of tier.events) finish(event, run.deadlineExceeded ? 'total-time-budget' : 'drain-ended');
    tier.actualDurationMs = now(); tier.finishedAt = new Date().toISOString(); tier.actualPosts = posted;
    tier.summary = summarizeTier(tier);
    tier.status = run.deadlineExceeded ? 'INCOMPLETE_TOTAL_TIME_BUDGET' : run.stop ? 'STOPPED_NEW_REQUESTS'
      : tier.summary.budgetLimited ? 'COMPLETE_WITH_POST_BUDGET_LIMIT' : 'COMPLETE_CONTROLLED_LOAD';
  }
  console.log(JSON.stringify({ tier: tierId, status: tier.status, summary: tier.summary }));
  return tier;
}

export function parseBenchmarkArgs(args) {
  const allowed = new Set(['--config-file', '--endpoint', '--model', '--profile', '--test-model', '--test-profile', '--thinking', '--rate', '--batch-size', '--max-requests']);
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    check(allowed.has(args[i]) && args[i + 1] && !args[i + 1].startsWith('--') && !values.has(args[i]), 'invalid-or-duplicate-argument');
    values.set(args[i], args[i + 1]);
  }
  check(!(values.has('--model') && values.has('--test-model')) && !(values.has('--profile') && values.has('--test-profile')), 'duplicate-model-selection');
  const model = values.get('--test-model') || values.get('--model'), profile = values.get('--test-profile') || values.get('--profile');
  check(values.get('--config-file'), 'explicit-config-file-required');
  check(model === 'deepseek-flash' && profile === 'deepseek', 'explicit-deepseek-flash-deepseek-required');
  const thinkingEffort = values.get('--thinking') || 'default';
  check(['default', 'off'].includes(thinkingEffort), 'thinking-must-be-default-or-explicit-off');
  const rate = Number(values.get('--rate') || 60), batchSize = Number(values.get('--batch-size') || 10), maxRequests = Number(values.get('--max-requests') || 400);
  check(Number.isInteger(rate) && rate >= 1 && rate <= 300, 'rate-must-be-1-to-300');
  check([5, 10, 20].includes(batchSize), 'batch-size-must-be-5-10-or-20');
  check(Number.isInteger(maxRequests) && maxRequests >= 4 && maxRequests <= 800, 'max-requests-must-be-4-to-800');
  return { configFile: values.get('--config-file'), endpoint: values.get('--endpoint'), model, profile, thinkingEffort, rate, batchSize, maxRequests };
}

export async function main(args) {
  if (args.includes('--help')) {
    console.log('node --experimental-strip-types scripts/benchmark-live-provider.mjs --config-file PATH --test-model deepseek-flash --test-profile deepseek [--thinking default|off] [--endpoint URL] [--rate 60] [--batch-size 10] [--max-requests 400]\nConcurrency 2/4/8/16; each uses the same recorded corpus order, a fixed 30-second feed and 3-second drain. Thinking defaults to service-default; off requires an explicit argument, with no automatic fallback. No retries. Explicit max requests may be 4..800. The authorized file locks the endpoint.');
    return;
  }
  const options = parseBenchmarkArgs(args);
  const authorized = await readAuthorizedLiveConfig(options.configFile).catch(() => { throw new BenchmarkError('authorized-config-invalid'); });
  const endpoint = options.endpoint ? completionEndpoint(options.endpoint, true) : authorized.settings.endpoint;
  check(endpoint === authorized.settings.endpoint, 'endpoint-must-match-authorized-file');
  const settings = normalizeSettings({ ...authorized.settings, endpoint, model: options.model, profile: options.profile,
    thinkingEffort: options.thinkingEffort, sourceLanguage: 'ja', targetLanguage: 'zh-Hans' });
  check(settings.model === options.model && settings.profile === options.profile && settings.thinkingEffort === options.thinkingEffort, 'selected-settings-not-preserved');
  const rawCorpus = await readFile(CORPUS_PATH, 'utf8');
  const corpus = selectCorpus(JSON.parse(rawCorpus).observation?.events);
  const base = resolve('.artifacts/live/provider-benchmark'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, `deepseek-flash-${options.thinkingEffort}-`));
  const endpointUrl = new URL(endpoint);
  const report = { root, capturedAt: new Date().toISOString(), status: 'running', evidence: 'REAL_PROVIDER_CONTROLLED_RECORDED_COMMENT_LOAD_NOT_LIVE_OR_BROWSER_ACCEPTANCE',
    selected: { endpoint: endpointUrl.origin + endpointUrl.pathname, model: settings.model, profile: settings.profile, thinkingEffort: settings.thinkingEffort,
      sourceLanguage: settings.sourceLanguage, targetLanguage: settings.targetLanguage, promptVersion: PROMPT_VERSION },
    load: { concurrencies: CONCURRENCIES, rate: options.rate, batchSize: options.batchSize, feedMs: FEED_MS, drainMs: DRAIN_MS,
      maxActualPosts: options.maxRequests, budgetPolicy: 'Equal reserved POST quotas per tier; unused quota is not moved between tiers.' },
    corpus: { path: resolve(CORPUS_PATH), fileSha256: hash(rawCorpus), eligibleOrderSha256: hash(JSON.stringify(corpus.items.map(item => item.text))),
      ...corpus, replay: 'Cycle the same eligible recorded event sequence in every tier; unique local IDs do not change source text.' },
    cache: { application: 'cold; direct Provider.complete, no engine/cache/deduplication, no warmup requests', remote: 'UNKNOWN; repeated source text may hit remote caches' },
    limits: ['Controlled local replay arrivals are not actual new live messages; no browser/native rendering acceptance is established.',
      'Event returnedAtMs is when Provider.complete settles, including rejected attempts; a return timestamp does not imply a valid output.',
      'Valid output counts require Provider ID/placeholder validation, nonempty output, changed text and return before the local deadline. Semantic translation quality is not rated; unchanged valid outputs are counted separately.',
      'Deadline timing starts at actual local enqueue and includes batch collection, queueing and HTTP/body parsing. No deadline renewal and no retries.',
      'All planned inputs stay in the success-rate denominator, including unsent, expired, timed out, invalid, unchanged and stopped inputs.',
      'HTTP duration includes failed/timed-out POST attempts. Local outstanding attempts do not prove remote compute stopped on cancellation.',
      'Configured concurrency is not measured capacity; input rate, POST quotas, remote cache and this fixed corpus may limit achieved concurrency.',
      'Direct Provider calls bypass the production per-tab quotas of 1200 new texts and 60000 characters per 60 seconds. The text quota averages 20 new texts/second; it is not a per-second hard ceiling, and repeated texts may be deduplicated or cached by the engine. Benchmark throughput is not product sustained throughput.',
      'No API key, request headers, reasoning output or raw service response body is recorded.'], tiers: [] };
  const run = { report, maxRequests: options.maxRequests, actualPosts: 0, stop: null, deadlineExceeded: false };
  await writeFile(resolve(root, 'report.json'), JSON.stringify(report, null, 2));
  const watchdog = setTimeout(() => { run.deadlineExceeded = true; }, CONCURRENCIES.length * (FEED_MS + DRAIN_MS) + 10000);
  try {
    for (const [index, concurrency] of CONCURRENCIES.entries()) {
      check(!run.deadlineExceeded, 'total-time-budget');
      const postQuota = Math.floor(options.maxRequests / CONCURRENCIES.length) + (index < options.maxRequests % CONCURRENCIES.length ? 1 : 0);
      await runTier({ tierId: `c${concurrency}`, concurrency, rate: options.rate, batchSize: options.batchSize, postQuota,
        corpus: corpus.items, settings, apiKey: authorized.apiKey, run });
      report.actualPosts = run.actualPosts; report.stop = run.stop;
      await writeFile(resolve(root, 'report.json'), JSON.stringify(report, null, 2));
    }
    report.status = benchmarkCompletionStatus({ deadlineExceeded: run.deadlineExceeded, stop: run.stop, tiers: report.tiers });
  } catch (error) { report.status = 'INCOMPLETE_BENCHMARK'; report.error = safeReason(error); }
  finally {
    clearTimeout(watchdog); authorized.apiKey = '';
    report.actualPosts = run.actualPosts; report.stop = run.stop; report.finishedAt = new Date().toISOString();
    report.checks = { postBudgetRespected: run.actualPosts <= options.maxRequests,
      noPostsAfterTerminalStop: !run.stop || run.actualPosts === run.stop.actualPostsAtStop,
      allTierInputsAccounted: report.tiers.every(tier => tier.events.every(event => event.completionReason !== null)),
      localConcurrencyWithinRequestedTiers: report.tiers.every(tier => tier.summary.peakActualConcurrency <= tier.concurrency) };
    if (!Object.values(report.checks).every(Boolean)) report.status = 'INCOMPLETE_BENCHMARK_ACCOUNTING';
    await writeFile(resolve(root, 'report.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({ report: resolve(root, 'report.json'), status: report.status, actualPosts: report.actualPosts, stop: report.stop }));
  if (report.status !== 'COMPLETE_CONTROLLED_PROVIDER_BENCHMARK') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ status: 'INCOMPLETE_BENCHMARK', error: safeReason(error) })); process.exitCode = 1; });
}
