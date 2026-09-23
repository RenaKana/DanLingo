// Recorded comment pool + real VideoScheduler/TranslationEngine/provider. No browser evidence.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, normalizeSettings, completionEndpoint, providerTimeoutMs, PROMPT_VERSION } from '../src/core/config.ts';
import { parseSources, needsTranslation, MAX_TEXT_LENGTH } from '../src/core/messages.ts';
import { VideoScheduler } from '../src/core/scheduler.ts';
import { preparationTime } from '../src/platforms/niconico/native.ts';
import { TranslationEngine, MemoryTranslationCache, protectText } from '../src/translation/index.ts';
import { discoverModels, ProviderError } from '../src/translation/provider.ts';
import { readNiconicoRecording, requireFileOption } from './probes/recording-input.mjs';
import { readTestKey } from './verify-real-provider.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_CASES = [
  { model: 'deepseek-flash', profile: 'deepseek', thinkingEffort: 'off' },
  { model: 'gemini-3.8-flash', profile: 'gemini', thinkingEffort: 'low' },
];
const MAX_POSTS = 40;
const MODEL_TIMEOUT_MS = 120_000;
const ORDINARY_COMMANDS = new Set(['184', 'naka', 'ue', 'shita', 'small', 'medium', 'big', 'defont', 'mincho', 'gothic',
  'white', 'red', 'pink', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'black',
  'white2', 'red2', 'pink2', 'orange2', 'yellow2', 'green2', 'cyan2', 'blue2', 'purple2', 'black2']);
const round = n => Math.round(n * 100) / 100;
const safeReason = error => error instanceof ProviderError && /^(?:http-\d{3}|[a-z][a-z-]{0,70})$/.test(error.message)
  ? error.message : 'benchmark-error';

function latencyStats(rows) {
  const values = rows.map(r => r.elapsedMs).filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = q => values.length ? values[Math.max(0, Math.ceil(values.length * q) - 1)] : null;
  return { count: values.length, meanMs: values.length ? round(values.reduce((n, v) => n + v, 0) / values.length) : null,
    minMs: values[0] ?? null, p50Ms: percentile(.5), p95Ms: percentile(.95), maxMs: values.at(-1) ?? null };
}

function recordedPool(recording) {
  // The recording contains raw API comments, not native player objects. Conservatively apply the
  // native ordinary-command/text rules, then reuse production source validation and protection.
  const candidates = recording.messages.filter(m => typeof m.body === 'string' && m.body.length > 0 && m.body.length <= MAX_TEXT_LENGTH
    && Number.isFinite(m.vposMs) && m.vposMs >= 0 && m.vposMs <= recording.durationSeconds * 1000
    && !/[\r\n]/u.test(m.body) && /[\u3040-\u30ff\uFF66-\uFF9D]/u.test(m.body)
    && ['main', 'easy'].includes(m.fork) && Array.isArray(m.commands)
    && m.commands.every(command => typeof command === 'string'
      && (ORDINARY_COMMANDS.has(command.toLowerCase()) || /^#[0-9a-f]{6}$/i.test(command))));
  return parseSources(candidates.map(m => {
    const commands = m.commands.map(c => c.toLowerCase());
    const position = commands.includes('ue') ? 'ue' : commands.includes('shita') ? 'shita' : 'naka';
    return { sourceId: m.id, threadId: m.threadId, fork: m.fork, originalText: m.body,
      mediaTimeMs: m.vposMs, renderAtMs: preparationTime(m.vposMs, position, recording.durationSeconds * 1000),
      sentAtEpochMs: Date.parse(m.postedAt), translatable: true, style: { position, commands: m.commands } };
  }), recording.watchId).filter(m => needsTranslation(m.originalText, 'zh-Hans', 'ja') && !protectText(m.originalText).reason);
}

async function runModel(settings, apiKey, sources, recording, budget, runSignal) {
  const started = performance.now();
  const requests = [];
  const prepared = new Set();
  const failures = new Map();
  let firstPreparedElapsedMs = null;
  let finishReason;
  let resolveFinished;
  const finished = new Promise(resolve => { resolveFinished = resolve; });
  const stop = reason => { if (!finishReason) { finishReason = reason; resolveFinished(); } };
  const cancel = () => stop('interrupted');
  runSignal.addEventListener('abort', cancel, { once: true });

  const measuredFetch = async (url, init) => {
    // Guard before native fetch: retries also pass here, so no more than 40 real POSTs can start.
    if (init.method !== 'POST' || url !== settings.endpoint) throw new ProviderError('benchmark-unexpected-request');
    if (budget.posts >= MAX_POSTS) {
      budget.blockedAttempts++; stop('post-attempt-limit');
      throw new ProviderError('benchmark-post-attempt-limit');
    }
    if (finishReason || runSignal.aborted) throw new ProviderError('cancelled');
    const body = JSON.parse(init.body);
    const envelope = JSON.parse(body.messages.find(m => m.role === 'user').content);
    const row = { attempt: ++budget.posts, model: body.model, thinkingEffort: settings.thinkingEffort,
      items: envelope.items.length, chars: envelope.items.reduce((n, item) => n + item.text.length, 0),
      startedElapsedMs: round(performance.now() - started) };
    // Store only safe request parameters, never messages, headers, credentials or response bodies.
    if (body.thinking) row.thinking = { type: body.thinking.type };
    if (typeof body.reasoning_effort === 'string') row.reasoning_effort = body.reasoning_effort;
    requests.push(row);
    const requestStarted = performance.now();
    let measured = false;
    const end = outcome => {
      if (measured) return;
      measured = true; row.elapsedMs = round(performance.now() - requestStarted); row.outcome = outcome;
      init.signal?.removeEventListener('abort', aborted);
    };
    const aborted = () => end('aborted');
    init.signal?.addEventListener('abort', aborted, { once: true });
    try {
      const response = await fetch(url, init);
      row.httpStatus = response.status;
      if (!response.body) { end('response-complete'); return response; }
      // Measure through the final body byte without inspecting or duplicating remote content.
      // Preserve URL/redirect metadata so the real provider still applies its origin checks.
      const reader = response.body.getReader();
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) { end('response-complete'); controller.close(); reader.releaseLock(); }
            else controller.enqueue(chunk.value);
          } catch { end('body-read-failed'); controller.error(new Error('body-read-failed')); }
        },
        async cancel() { end('body-cancelled'); try { await reader.cancel(); } catch {} finally { reader.releaseLock(); } },
      });
      const measuredResponse = new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
      Object.defineProperties(measuredResponse, { url: { value: response.url }, redirected: { value: response.redirected } });
      return measuredResponse;
    } catch { end(init.signal?.aborted ? 'aborted' : 'network-error'); throw new ProviderError('network-error', true); }
  };
  const engine = new TranslationEngine({ fetch: measuredFetch, cache: new MemoryTranslationCache(), maxConcurrency: 2, maxRequestItems: 200 });
  const scheduler = new VideoScheduler({
    settings,
    request: async (resourceId, items, signal, priority) => {
      const result = await engine.translate({ resourceId, apiKey, settings, mode: 'vod', priority,
        quotaScope: 'recorded-vod-benchmark', signal,
        items: items.map(item => ({ id: item.id, text: item.text, deadlineAt: performance.now() + settings.requestTimeoutMs })) });
      for (const item of result.items) {
        const usable = (item.status === 'translated' || item.status === 'cached')
          && typeof item.text === 'string' && item.text.trim() && item.text.length <= 2000;
        if (item.status !== 'deferred' && !usable) {
          failures.set(item.id, /^[a-z][a-z0-9-]{0,70}$/.test(item.reason ?? '') ? item.reason : 'unusable-translation');
        }
      }
      return result.items;
    },
    prepared: rows => {
      if (firstPreparedElapsedMs === null && rows.length) firstPreparedElapsedMs = round(performance.now() - started);
      for (const row of rows) { prepared.add(row.id); failures.delete(row.id); }
    },
    reset: () => {},
    status: stats => {
      if (stats.sourceComplete && stats.messages === sources.length && stats.queued === 0 && stats.inflight === 0
        && stats.translated + stats.failed === sources.length) stop('settled');
    },
  });
  let timer, ticker, stats, engineStats, elapsedMs;
  try {
    timer = setTimeout(() => stop('model-timeout'), MODEL_TIMEOUT_MS);
    ticker = setInterval(() => scheduler.tick(), 100);
    if (runSignal.aborted) cancel();
    else scheduler.snapshot(recording.watchId, 'recorded-vod-benchmark', {
      mediaTimeMs: 0, playbackRate: 1, paused: true, seeking: false, contentActive: true,
      durationMs: recording.durationSeconds * 1000, buffered: [],
    }, sources);
    await finished;
    elapsedMs = round(performance.now() - started);
    stats = scheduler.getStats(); engineStats = engine.stats();
  } finally {
    clearTimeout(timer); clearInterval(ticker); runSignal.removeEventListener('abort', cancel);
    scheduler.dispose(); engine.dispose();
  }
  return { model: settings.model, profile: settings.profile, thinkingEffort: settings.thinkingEffort,
    effectiveRequestTimeoutMs: providerTimeoutMs(settings),
    outcome: finishReason, complete: finishReason === 'settled', allReady: prepared.size === sources.length,
    eligiblePool: sources.length, ready: prepared.size, failed: stats.failed, unsettled: Math.max(0, sources.length - prepared.size - stats.failed),
    firstPreparedElapsedMs, wholeEligiblePoolSettledElapsedMs: finishReason === 'settled' ? elapsedMs : null, observedElapsedMs: elapsedMs,
    realPostCalls: requests.length,
    averageRealPostItems: requests.length ? round(requests.reduce((n, r) => n + r.items, 0) / requests.length) : null,
    requestLatency: latencyStats(requests), requests, scheduler: stats,
    engine: { retries: engineStats.retries, mergedInputs: engineStats.mergedInputs, cacheHits: engineStats.cacheHits,
      deferred: engineStats.deferred, usage: engineStats.usage },
    events: sources.map(m => ({ id: m.id, mediaTimeMs: m.mediaTimeMs, renderAtMs: m.renderAtMs,
      status: prepared.has(m.id) ? 'ready' : failures.has(m.id) ? 'failed' : 'unsettled',
      ...(failures.has(m.id) ? { reason: failures.get(m.id) } : {}) })) };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`Usage (PowerShell, interactive terminal):
  $env:DANLINGO_E2E_ENDPOINT = 'https://your-authorized-service.example/v1'
  node --experimental-strip-types scripts/verify-vod-provider.mjs --recording <json-file>

The endpoint has no default. The API Key is requested with echo disabled; do not put it
in arguments, environment variables or files. The explicit recording is validated before
credential input or service requests. --help performs no network requests.
Runs deepseek-flash / off and gemini-3.8-flash / low, with a fresh memory cache per model.
The entire eligible Japanese comment pool from the selected recording is offered to the
production all-scope VideoScheduler and TranslationEngine.
Fixed playback clock: paused at 0 video seconds; nearby comments receive priority.
Settings: batch 100 / 12000 chars, concurrency 2, near window 5 video seconds.
Request timeout: thinking off 12s; thinking enabled or service default 120s.
Limits: 120s per model and at most 40 actual POST attempts total, including engine retries.
GET /models checks the exact model IDs when available; no model is substituted.
Writes .artifacts/vod/provider/provider-<timestamp>.json. This benchmarks recorded source,
scheduler and REAL provider requests; it does not establish browser/native rendering or
complete live video history. Reports contain counts, timings and event IDs, not credentials,
headers, source/translation text, reasoning content or remote response bodies.`);
    return;
  }
  const recordingPath = requireFileOption(args, '--recording');
  const { recording, fileName } = await readNiconicoRecording(recordingPath);
  const configuredEndpoint = process.env.DANLINGO_E2E_ENDPOINT;
  if (!configuredEndpoint) throw new Error('Set DANLINGO_E2E_ENDPOINT to an explicitly authorized service endpoint');
  let endpoint;
  try { endpoint = completionEndpoint(configuredEndpoint, true); }
  catch { throw new Error('DANLINGO_E2E_ENDPOINT must be a valid HTTPS or private/local HTTP completion endpoint'); }
  const sources = recordedPool(recording);
  if (!sources.length) throw new Error('No eligible recorded comments');
  const apiKey = await readTestKey();
  if (apiKey.length > 4096) throw new Error('Invalid credential input');
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, endpoint, allowLocalHttp: true, enabled: true,
    translationScope: 'all', sourceLanguage: 'ja', targetLanguage: 'zh-Hans', batchSize: 100,
    maxBatchChars: 12000, concurrency: 2, urgentSeconds: 5, requestTimeoutMs: 12000, thinkingRequestTimeoutMs: 120000 });
  const report = { capturedAt: new Date().toISOString(), evidence: 'recorded-source-production-scheduler-real-provider-NOT-browser',
    endpoint, promptVersion: PROMPT_VERSION,
    source: { fileName, capturedAt: recording.capturedAt, resourceId: recording.watchId,
      eligiblePool: sources.length,
      completeLiveHistory: false, scope: 'entire-eligible-recorded-pool',
      selection: 'within video duration, ordinary-command allowlist, no owner/newline, contains Japanese kana, production source validation/text protection',
      sourceTiming: 'original vposMs retained; production preparationTime derives staging deadlines including end-of-video clamping' },
    settings: { batchSize: 100, maxBatchChars: 12000, concurrency: 2, urgentSeconds: 5, requestTimeoutMs: 12000,
      thinkingRequestTimeoutMs: 120000,
      translationScope: 'all', sourceLanguage: 'ja', targetLanguage: 'zh-Hans', playback: 'paused-at-zero-no-buffer', freshCachePerModel: true },
    limits: { maxActualPostAttempts: MAX_POSTS, perModelMs: MODEL_TIMEOUT_MS },
    latencyDefinition: 'POST dispatch through response body completion, cancellation or transport failure; remote content is not inspected',
    models: [] };
  const budget = { posts: 0, blockedAttempts: 0 };
  const runController = new AbortController();
  const interrupt = () => runController.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    let available;
    let discoveryBlocked;
    try {
      available = await discoverModels({ endpoint, allowLocalHttp: true, apiKey, timeoutMs: 12000, signal: runController.signal });
      report.modelDiscovery = { outcome: 'available', verified: MODEL_CASES.map(({ model }) => ({ model, listed: available.includes(model) })) };
    } catch (error) {
      const reason = safeReason(error);
      report.modelDiscovery = { outcome: 'unavailable', reason, exactNamedModelsOnly: true };
      if (reason === 'http-401' || reason === 'http-403' || reason === 'cancelled') discoveryBlocked = reason;
    }
    for (const config of MODEL_CASES) {
      const blocked = runController.signal.aborted ? 'interrupted' : discoveryBlocked
        || (available && !available.includes(config.model) ? 'model-not-listed' : null)
        || (budget.posts >= MAX_POSTS ? 'post-attempt-limit' : null);
      if (blocked) {
        report.models.push({ ...config, outcome: blocked, complete: false, allReady: false,
          eligiblePool: sources.length, ready: 0, failed: 0, unsettled: sources.length, realPostCalls: 0,
          averageRealPostItems: null, firstPreparedElapsedMs: null, wholeEligiblePoolSettledElapsedMs: null });
        continue;
      }
      console.log(`Running ${config.model} (${config.thinkingEffort}); ${sources.length} eligible recorded events.`);
      report.models.push(await runModel(normalizeSettings({ ...settings, ...config }), apiKey, sources, recording, budget, runController.signal));
    }
  } catch { report.error = 'benchmark-run-failed'; }
  finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    report.actualPostAttempts = budget.posts; report.blockedPostAttempts = budget.blockedAttempts;
    report.complete = report.models.length === MODEL_CASES.length && report.models.every(m => m.complete);
    report.allReady = report.complete && report.models.every(m => m.allReady);
    const directory = resolve(ROOT, '.artifacts/vod/provider');
    await mkdir(directory, { recursive: true });
    const path = resolve(directory, `provider-${report.capturedAt.replaceAll(/[:.]/g, '-')}.json`);
    await writeFile(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(`Report: ${path}`);
    console.log(JSON.stringify({ complete: report.complete, allReady: report.allReady, actualPostAttempts: budget.posts,
      models: report.models.map(({ model, outcome, ready, failed, unsettled, realPostCalls, averageRealPostItems,
        firstPreparedElapsedMs, wholeEligiblePoolSettledElapsedMs }) => ({ model, outcome, ready, failed, unsettled,
        realPostCalls, averageRealPostItems, firstPreparedElapsedMs, wholeEligiblePoolSettledElapsedMs })) }, null, 2));
    if (!report.allReady) process.exitCode = 1;
  }
}

void main().catch(error => { console.error(error instanceof Error && [
  'Expected --recording <json-file>', 'Real Niconico query evidence is required; synthetic fixtures are not accepted',
  'Invalid Niconico recording structure', 'Invalid Niconico recording messages', 'Invalid Niconico recording source URLs',
  'Niconico recording must identify its public watch page and comment endpoint',
  'Set DANLINGO_E2E_ENDPOINT to an explicitly authorized service endpoint',
  'DANLINGO_E2E_ENDPOINT must be a valid HTTPS or private/local HTTP completion endpoint', 'No eligible recorded comments',
  'An interactive terminal is required for non-echoing credential input', 'Invalid credential input', 'Cancelled',
].includes(error.message) ? error.message : 'Benchmark setup/report failed; no credential or remote body was logged.'); process.exitCode = 1; });
