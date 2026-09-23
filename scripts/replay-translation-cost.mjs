import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { calculateAttemptCost, normalizeCostUsage, summarizeCostReplay } from './translation-cost-metrics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.byteLength(value, 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

class ReplayClock {
  time = 0;
  sequence = 0;
  timers = new Map();
  now() { return this.time; }
  wallNow() { return 1800000000000 + this.time; }
  setTimeout(callback, delay) {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + Math.max(0, delay), callback });
    return id;
  }
  clearTimeout(id) { this.timers.delete(id); }
  async advanceTo(target) {
    await flush();
    for (let count = 0; ; count++) {
      assert.ok(count < 100000, 'replay encountered a timer loop');
      const next = [...this.timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.time = Math.max(this.time, next[1].at);
      this.timers.delete(next[0]); next[1].callback(); await flush();
    }
    this.time = target; await flush();
  }
}

async function loadImplementation(directory) {
  const importFile = relative => import(pathToFileURL(path.join(directory, relative)).href);
  const [engine, scheduler, config, text, messages] = await Promise.all([
    importFile('src/translation/engine.ts'), importFile('src/core/live-scheduler.ts'), importFile('src/core/config.ts'),
    importFile('src/translation/text.ts'), importFile('src/core/messages.ts'),
  ]);
  const sourceHashes = {};
  for (const relative of ['src/translation/engine.ts', 'src/translation/provider.ts', 'src/translation/cache.ts',
    'src/translation/text.ts', 'src/core/live-scheduler.ts', 'src/core/config.ts', 'src/core/types.ts', 'src/core/messages.ts']) {
    sourceHashes[relative] = hash(await readFile(path.join(directory, relative)));
  }
  try { sourceHashes['src/translation/telemetry.ts'] = hash(await readFile(path.join(directory, 'src/translation/telemetry.ts'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...engine, ...scheduler, ...config, ...text, ...messages, sourceHashes };
}

/** Exported for fixture/denominator checks. IDs identify occurrences, never a deduplicated display. */
export function generateProfile(fixture, profile) {
  return Array.from({ length: profile.count }, (_, index) => {
    const sourceIndex = profile.repeatPool ? index % profile.repeatPool : index;
    const sample = profile.longEvery && sourceIndex % profile.longEvery === 0
      ? fixture.longSample : fixture.samples[sourceIndex % fixture.samples.length];
    const suffix = ` [${sourceIndex}]`;
    return { id: `${profile.name}:${index}`, text: sample.source + suffix, translated: sample.translated + suffix,
      receivedAt: index * profile.intervalMs + Math.floor(index / (profile.burstSize ?? Infinity)) * (profile.burstGapMs ?? 0),
      sourceUnits: sample.sourceUnits, outputUnits: sample.outputUnits,
      fault: profile.faults?.[sourceIndex % profile.faults.length] ?? 'none' };
  });
}

function decodeBody(body) {
  const user = body.messages.find(message => message.role === 'user')?.content;
  assert.equal(typeof user, 'string', 'expected the real provider request body');
  let envelope;
  try { envelope = JSON.parse(user); } catch { /* Multiline JSONL is expected for compact requests. */ }
  if (Array.isArray(envelope?.items)) return { protocol: 'object', user, rows: envelope.items };
  const rows = user.split('\n').filter(line => line.trim()).map(line => {
    const row = JSON.parse(line);
    assert.ok(Array.isArray(row) && row.length === 2 && Number.isInteger(row[0]) && typeof row[1] === 'string', 'unknown wire protocol');
    return { id: row[0], text: row[1] };
  });
  return { protocol: 'jsonl', user, rows };
}

async function replay(implementation, config, fixture, profile, rates, captureProtocol = false) {
  const clock = new ReplayClock(), sourceRows = generateProfile(fixture, profile);
  const occurrences = sourceRows.map(row => ({ id: row.id, uniqueId: hash(row.text).slice(0, 20),
    receivedAt: row.receivedAt, schedulerQueuedAt: row.receivedAt, displayAt: row.receivedAt + config.liveBufferMs,
    eligible: implementation.needsTranslation(row.text, config.targetLanguage, config.liveSourceLanguage) && !implementation.protectText(row.text).reason,
    failures: [] }));
  const byOccurrence = new Map(occurrences.map(row => [row.id, row]));
  const byText = new Map(sourceRows.map(row => [implementation.protectText(row.text).text, row]));
  const uniqueAttempts = new Map(), attempts = [], engineTrace = [], engineOccurrences = new Map();
  let admissionIds = [], currentEngineBatch;
  let activeTransport = 0, maxActiveTransport = 0, peakQueuedItems = 0;
  const fetch = (_url, init) => {
    const body = JSON.parse(init.body), decoded = decodeBody(body);
    assert.equal(body.model, config.model); assert.equal(body.thinking?.type, 'disabled', 'replay requires the actual no-thinking field');
    const rows = decoded.rows.map(wire => {
      const row = byText.get(wire.text);
      assert.ok(row, 'provider changed source text outside the fixed protection contract');
      const uniqueId = hash(row.text).slice(0, 20), previous = uniqueAttempts.get(uniqueId) ?? 0;
      uniqueAttempts.set(uniqueId, previous + 1);
      return { ...row, wireId: wire.id, uniqueId, attempt: previous + 1 };
    });
    const attempt = { id: `request:${attempts.length + 1}`, sentAt: clock.now(), protocol: decoded.protocol,
      uniqueIds: rows.map(row => row.uniqueId), retry: rows.some(row => row.attempt > 1), batchSize: rows.length,
      status: 'inflight', formatFailures: 0,
      bytes: { fixedPrompt: bytes(body.messages.filter(message => message.role === 'system').map(message => message.content).join('\n')),
        source: rows.reduce((sum, row) => sum + bytes(implementation.protectText(row.text).text), 0),
        inputFormat: bytes(decoded.user) - rows.reduce((sum, row) => sum + bytes(implementation.protectText(row.text).text), 0),
        request: bytes(init.body) } };
    if (currentEngineBatch) attempt.engineBatchId = currentEngineBatch.batchId;
    if (captureProtocol) attempt.protocolContent = {
      system: body.messages.filter(message => message.role === 'system').map(message => message.content),
      user: decoded.user, sources: decoded.rows.map(row => row.text), output: null, outputTexts: [],
    };
    attempts.push(attempt);
    activeTransport++; maxActiveTransport = Math.max(maxActiveTransport, activeTransport);
    const firstNetworkFailure = rows.some(row => row.fault === 'network' && row.attempt === 1);
    const timeout = rows.some(row => row.fault === 'timeout');
    const duration = firstNetworkFailure ? fixture.latency.networkErrorMs : timeout ? fixture.latency.timeoutMs
      : fixture.latency.baseMs + rows.reduce((sum, row) => sum + row.outputUnits, 0) * fixture.latency.perOutputUnitMs;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = callback => {
        if (done) return;
        done = true; activeTransport--; clock.clearTimeout(timer); init.signal.removeEventListener('abort', abort);
        attempt.completedAt = clock.now(); callback();
      };
      const abort = () => finish(() => { attempt.status = 'cancelled-or-timeout'; reject(new DOMException('simulated cancellation', 'AbortError')); });
      const timer = clock.setTimeout(() => finish(() => {
        if (firstNetworkFailure) { attempt.status = 'network-error'; reject(new TypeError('synthetic network failure')); return; }
        const delivered = rows.filter(row => !(row.fault === 'missing-row' && row.attempt === 1));
        const invalidFormat = rows.some(row => row.fault === 'invalid-format');
        attempt.formatFailures = invalidFormat ? rows.length : rows.length - delivered.length;
        const output = invalidFormat ? 'synthetic malformed response'
          : decoded.protocol === 'jsonl' ? delivered.map(row => JSON.stringify([row.wireId, implementation.protectText(row.translated).text])).join('\n')
          : JSON.stringify({ items: delivered.map(row => ({ id: row.wireId, text: implementation.protectText(row.translated).text })) });
        if (captureProtocol) { attempt.protocolContent.output = output; attempt.protocolContent.outputTexts = invalidFormat ? [] : delivered.map(row => implementation.protectText(row.translated).text); }
        const ledger = fixture.usageFixture;
        const allocation = {
          fixedInput: ledger.fixedInputTokens,
          inputFormat: rows.length * ledger.inputFormatTokensPerItem,
          source: rows.reduce((sum, row) => sum + row.sourceUnits, 0),
          outputFormat: ledger.fixedOutputTokens + delivered.length * ledger.outputFormatTokensPerItem,
          outputText: delivered.reduce((sum, row) => sum + row.outputUnits, 0),
        };
        const prompt = allocation.fixedInput + allocation.inputFormat + allocation.source;
        const completion = allocation.outputFormat + allocation.outputText;
        const rawUsage = rows.some(row => row.fault === 'missing-usage') ? undefined
          : rows.some(row => row.fault === 'partial-usage') ? { prompt_tokens: prompt }
          : { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
            prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } };
        attempt.usage = normalizeCostUsage(rawUsage);
        attempt.simulatedTokenAllocation = allocation;
        attempt.bytes.outputFormat = bytes(output) - (invalidFormat ? 0 : delivered.reduce((sum, row) => sum + bytes(implementation.protectText(row.translated).text), 0));
        attempt.status = invalidFormat ? 'invalid-format' : delivered.length < rows.length ? 'partial-output' : 'ok';
        if (body.stream) {
          // Optional adapter compatibility only: one complete delta, no simulated early-line advantage.
          const events = [{ choices: [{ delta: { content: output }, finish_reason: null }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }], ...(rawUsage ? { usage: rawUsage } : {}) }];
          resolve(new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } }));
        } else resolve(Response.json({ choices: [{ message: { role: 'assistant', content: output }, finish_reason: 'stop' }], ...(rawUsage ? { usage: rawUsage } : {}) }));
      }), duration);
      init.signal.addEventListener('abort', abort, { once: true });
      if (init.signal.aborted) abort();
    });
  };
  const engine = new implementation.TranslationEngine({ clock, fetch, maxConcurrency: config.concurrency,
    onTrace(event) {
      engineTrace.push(event);
      if (event.type === 'arrival') {
        const originalId = admissionIds.shift();
        if (originalId) { engineOccurrences.set(event.occurrenceId, originalId); byOccurrence.get(originalId).engineOccurrenceId = event.occurrenceId; }
      } else if (event.type === 'bind') {
        const row = byOccurrence.get(engineOccurrences.get(event.occurrenceId));
        if (row) row.engineTaskId = event.taskId;
      } else if (event.type === 'attempt') currentEngineBatch = event;
    } });
  const session = { platform: 'youtube', scenario: 'live', resourceId: 'costReplay1', sessionId: 'synthetic', generation: 1 };
  const captureResult = output => {
    const row = byOccurrence.get(output.id);
    if (row && output.reason && !row.failures.includes(output.reason)) row.failures.push(output.reason);
  };
  const scheduler = new implementation.LiveScheduler({ settings: config, clock,
    async request(_session, items, signal, onResult) {
      for (const item of items) byOccurrence.get(item.id).engineEnqueuedAt ??= clock.now();
      admissionIds = items.map(item => item.id);
      const response = await engine.translate({ resourceId: 'youtube:live:costReplay1', settings: config, apiKey: 'synthetic-key-never-sent', signal,
        mode: 'deadline', quotaScope: 'synthetic-replay',
        items: items.map(item => ({ id: item.id, text: item.text, deadlineAt: clock.now() + item.remainingMs })),
        onResult: output => { captureResult(output); onResult?.(output); } });
      response.items.forEach(captureResult);
      return response.items;
    },
    prepare(event) {
      const row = byOccurrence.get(event.source.id);
      if (row.readyAt === undefined) { row.readyAt = event.preparedAt; row.validTranslation = event.translated; row.cached = event.cached; }
    },
    release(event) {
      const row = byOccurrence.get(event.source.id);
      assert.equal(row.releasedAt, undefined, 'an original occurrence must never release twice');
      row.releasedAt = event.releasedAt; row.releasedTranslated = event.translated;
      if (event.preparedAt !== undefined && row.readyAt === undefined) { row.readyAt = event.preparedAt; row.validTranslation = event.translated; row.cached = event.cached; }
      assert.equal(event.displayAt, row.displayAt, 'buffer budget changed during replay');
      return true;
    },
    status() { peakQueuedItems = Math.max(peakQueuedItems, engine.stats().queuedItems); },
  });
  scheduler.start(session); scheduler.setConnection('connected');
  scheduler.setPlayback({ paused: false, seeking: false, contentActive: true, atLiveEdge: true });
  for (const source of sourceRows) clock.setTimeout(() => scheduler.ingest([{ id: source.id, sourceId: source.id,
    originalText: source.text, receivedAt: source.receivedAt, translatable: true }]), source.receivedAt);
  await clock.advanceTo(sourceRows.at(-1).receivedAt + config.liveBufferMs + fixture.latency.timeoutMs + 500);
  const engineStats = engine.stats(), schedulerStats = scheduler.getStats();
  scheduler.dispose(); engine.dispose(); await flush();
  assert.equal(activeTransport, 0); assert.equal(engineStats.pendingItems, 0);
  assert.ok(maxActiveTransport <= config.concurrency, 'retries must share the same concurrency limit');
  const summary = summarizeCostReplay({ occurrences, attempts, rates });
  for (const attempt of attempts) attempt.cost = calculateAttemptCost(attempt, rates);
  const uniqueTexts = [...new Set(occurrences.map(row => row.uniqueId))].map(id => ({ id,
    occurrenceIds: occurrences.filter(row => row.uniqueId === id).map(row => row.id),
    // Logical text-key provenance, including prior cached results; not a claim that future occurrences joined prior requests.
    relatedAttemptIds: attempts.filter(attempt => attempt.uniqueIds.includes(id)).map(attempt => attempt.id) }));
  return { summary, maxActiveTransport, peakQueuedItems, engineStats, schedulerStats, occurrences, uniqueTexts, attempts, engineTrace };
}

export async function runReplay(options = {}) {
  const fixturePath = options.fixture ?? path.join(root, 'test/fixtures/translation-cost-replay.json');
  const fixtureText = await readFile(fixturePath, 'utf8'), fixture = JSON.parse(fixtureText);
  const baselinePath = path.resolve(options.baseline ?? path.join(root, '.artifacts/cost-optimization/baseline-source'));
  const [baseline, current] = await Promise.all([loadImplementation(baselinePath), loadImplementation(root)]);
  const settings = { ...baseline.DEFAULT_SETTINGS, ...fixture.settings, enabled: true, displayMode: 'translated',
    endpoint: 'https://synthetic.invalid/v1/chat/completions', model: 'synthetic-replay-no-thinking', profile: 'deepseek',
    thinkingEffort: 'off', sourceLanguage: 'ja', liveSourceLanguage: 'ja', targetLanguage: 'zh-Hans', translationStream: false,
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}), ...(options.bufferMs !== undefined ? { liveBufferMs: options.bufferMs } : {}) };
  assert.ok(Number.isInteger(settings.concurrency) && settings.concurrency >= 1 && settings.concurrency <= Math.min(baseline.MAX_CONCURRENCY, current.MAX_CONCURRENCY),
    `paired replay requires the common supported concurrency range 1..${Math.min(baseline.MAX_CONCURRENCY, current.MAX_CONCURRENCY)}; it cannot validate a higher new-only limit`);
  assert.ok(Number.isInteger(settings.batchSize) && settings.batchSize >= 1 && settings.batchSize <= 200, 'batch size must be an integer 1..200');
  assert.ok(Number.isInteger(settings.liveBufferMs) && settings.liveBufferMs >= 500 && settings.liveBufferMs <= 5000, 'buffer must be an integer 500..5000ms');
  const rates = options.rates ?? fixture.rates;
  const report = { schemaVersion: 1, evidence: 'deterministic synthetic engine + LiveScheduler replay; not a real provider bill or translation-quality evaluation',
    fixtureSha256: hash(fixtureText), settings, rates,
    methodology: {
      arrivals: 'The same independent raw occurrence IDs and original arrival intervals are scheduled on both monotonic clocks.',
      usage: 'Invented fixed token allocations in the fixture, identical for both protocols. They are returned as simulated response usage, not character counts, tokenizer estimates, real token measurements, or evidence of prompt-token savings.',
      payloadBytes: 'Measured UTF-8 request bytes; fixed prompt, input format, protected source and output format stay explicitly in bytes.',
      associations: 'Raw occurrences link to logical uniqueTexts and their request provenance. Current-only engine trace additionally supplies actual occurrence/task/batch IDs; baseline has no equivalent hook. Engine queue token sizing estimates are not the simulated usage ledger.',
      billing: 'Nominal configured rates per million; total/per-1000 cost is null if any attempt has missing, incomplete or unverifiable usage. Known subtotal includes failed responses with usage.',
      failures: 'Faults attach to source identities, not request ordinal. A network/timeout row affects its whole real batch; different batching can change collateral failures.',
      readiness: 'Time from raw arrival to LiveScheduler accepting a complete valid result; reported percentiles condition on on-time success. All eligible raw occurrences remain in coverage denominator.',
      limits: 'No browser transport overhead, physical renderer, platform network, model quality, gateway prices, upstream cache efficacy, streaming latency or real 64-way provider capacity is established.',
    },
    prefixCache: { status: 'unverified', coldStart: 'each profile starts with an empty local cache', stablePhase: 'local reuse may occur inside each profile; upstream cached-token zeros are mock fields only' },
    baseline: { directory: path.relative(root, baselinePath).replaceAll('\\', '/'), maximumConcurrency: baseline.MAX_CONCURRENCY, sourceHashes: baseline.sourceHashes },
    current: { maximumConcurrency: current.MAX_CONCURRENCY, sourceHashes: current.sourceHashes }, profiles: [] };
  const selected = fixture.profiles.filter(profile => !options.profile || profile.name === options.profile);
  assert.ok(selected.length, 'unknown profile');
  for (const profile of selected) {
    const oldResult = await replay(baseline, settings, fixture, profile, rates, options.captureProtocol);
    const newResult = await replay(current, settings, fixture, profile, rates, options.captureProtocol);
    assert.deepEqual(oldResult.occurrences.map(row => [row.id, row.receivedAt, row.displayAt, row.eligible]),
      newResult.occurrences.map(row => [row.id, row.receivedAt, row.displayAt, row.eligible]), 'paired denominator or timing drift');
    const oldCost = oldResult.summary.cost.per1000Raw, newCost = newResult.summary.cost.per1000Raw;
    const coveragePreserved = newResult.summary.onTimeCoverage >= oldResult.summary.onTimeCoverage;
    report.profiles.push({ name: profile.name, baseline: oldResult, current: newResult,
      comparison: { coveragePreserved, simulatedCostDeltaPer1000Raw: oldCost === null || newCost === null ? null : newCost - oldCost,
        conclusion: oldCost === null || newCost === null ? 'cost-unknown: do not claim savings'
          : !coveragePreserved ? 'fails-coverage-condition'
          : newCost < oldCost ? 'lower-simulated-cost-only: real savings and quality unverified' : 'no-lower-simulated-cost' } });
  }
  return report;
}

async function main() {
  const args = process.argv.slice(2), options = {};
  let output = path.join(root, '.artifacts/cost-optimization/replay.json');
  for (let index = 0; index < args.length; index++) {
    const flag = args[index], value = args[++index];
    assert.ok(value, `missing value for ${flag}`);
    if (flag === '--output') output = path.resolve(value);
    else if (flag === '--baseline') options.baseline = path.resolve(value);
    else if (flag === '--fixture') options.fixture = path.resolve(value);
    else if (flag === '--profile') options.profile = value;
    else if (flag === '--rates') options.rates = JSON.parse(await readFile(path.resolve(value), 'utf8'));
    else if (flag === '--concurrency') options.concurrency = Number(value);
    else if (flag === '--batch-size') options.batchSize = Number(value);
    else if (flag === '--buffer-ms') options.bufferMs = Number(value);
    else throw new Error(`unknown option ${flag}`);
  }
  const report = await runReplay(options);
  await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, evidence: report.evidence,
    profiles: report.profiles.map(profile => ({ name: profile.name, baseline: profile.baseline.summary, current: profile.current.summary, comparison: profile.comparison })) }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
