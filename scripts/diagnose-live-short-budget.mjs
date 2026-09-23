// Offline characterization of the current engine, not a product acceptance gate.
// No credential file, browser, native fetch, private timing mutation or real Provider.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_SETTINGS } from '../src/core/config.ts';
import { cacheResource } from '../src/core/resource.ts';
import { TranslationEngine } from '../src/translation/engine.ts';

if (process.argv.includes('--help')) {
  console.log('node --experimental-strip-types scripts/diagnose-live-short-budget.mjs\nOffline bounded engine observation; writes a new diagnostic report, no credentials/network.');
  process.exit(0);
}
assert.equal(process.argv.length, 2, 'No arguments are accepted; this script cannot call a real Provider');
async function flush() { for (let turn = 0; turn < 100; turn++) await Promise.resolve(); }
class Clock {
  time = 1000; sequence = 0; timers = new Map();
  now() { return this.time; }
  wallNow() { return 1800000000000 + this.time; }
  setTimeout(callback, delay) {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + Math.max(0, delay), callback }); return id;
  }
  clearTimeout(id) { this.timers.delete(id); }
  async advance(ms) {
    const target = this.time + ms; await flush();
    for (let turn = 0; ; turn++) {
      assert.ok(turn < 10000, 'Timer iteration bound');
      const next = [...this.timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = Math.max(this.time, next[1].at); this.timers.delete(next[0]); next[1].callback(); await flush();
    }
    this.time = target; await flush();
  }
}
const settings = { ...DEFAULT_SETTINGS, enabled: true, batchSize: 2, concurrency: 2,
  endpoint: 'https://synthetic.invalid/v1/chat/completions', model: 'synthetic-model',
  sourceLanguage: 'ja', targetLanguage: 'zh-Hans', liveMaxBatchWaitMs: 150,
  liveAdaptiveConcurrency: false, translationStream: false };
async function observe({ name, warm, budgetMs, responseMs, count = 2 }) {
  const clock = new Clock(), calls = [], traces = [];
  let phase = 'warmup', latency = 800, requests = 0;
  const fetch = (_url, init) => new Promise((done, reject) => {
    assert.ok(calls.length < 5, 'Synthetic fetch count bound');
    const content = JSON.parse(init.body).messages.find(row => row.role === 'user').content;
    const rows = content.split('\n').filter(Boolean).map(JSON.parse);
    const call = { phase, at: clock.now(), items: rows.length, injectedResponseMs: latency, result: 'pending' };
    calls.push(call);
    const timer = clock.setTimeout(() => {
      call.result = 'response'; call.settledAt = clock.now();
      done(Response.json({ choices: [{ message: { content: rows.map(([id]) => JSON.stringify([id, '合成译文'])).join('\n') } }] }));
    }, latency);
    init.signal.addEventListener('abort', () => {
      if (call.result !== 'pending') return;
      clock.clearTimeout(timer); call.result = 'aborted'; call.settledAt = clock.now();
      reject(new DOMException('synthetic abort', 'AbortError'));
    }, { once: true });
  });
  const engine = new TranslationEngine({ clock, fetch, onTrace: trace => traces.push(trace) });
  const submit = (items, budget) => {
    const requestId = ++requests;
    return engine.translate({ settings, resourceId: cacheResource({ platform: 'youtube', scenario: 'live', resourceId: 'diagnostic' }),
      mode: 'deadline', apiKey: 'test-only-key', items: Array.from({ length: items }, (_, index) => ({
        id: `${requestId}-${index}`, text: `日本語の検証文章 ${requestId} ${index}`, deadlineAt: clock.now() + budget,
      })) });
  };
  try {
    if (warm) {
      const pending = submit(2, 2000); await clock.advance(800);
      const result = await pending;
      assert.deepEqual(result.items.map(row => row.status), ['translated', 'translated'], 'Warmup must really complete');
      assert.equal(calls.length, 1); assert.equal(calls[0].items, 2);
      assert.ok(traces.some(trace => trace.type === 'settled' && trace.status === 'completed' && trace.durationMs === 800));
    }
    phase = 'measured'; latency = responseMs;
    const admittedAt = clock.now(), pending = submit(count, budgetMs);
    await clock.advance(Math.max(budgetMs, responseMs) + 200);
    const result = await pending, stats = engine.stats();
    const measured = calls.filter(call => call.phase === 'measured');
    assert.equal(stats.activeRequests, 0); assert.equal(stats.pendingItems, 0);
    assert.equal(result.items.length, count); assert.equal(stats.retries, 0);
    assert.ok(calls.every(call => call.result !== 'pending'));
    return { name, warmupMs: warm ? 800 : null, budgetMs, responseMs, sourceEvents: count,
      injectedFetches: measured.map(call => ({ ...call, remainingBudgetAtSend: admittedAt + budgetMs - call.at })),
      dispatchDecisions: traces.filter(trace => trace.type === 'attempt').slice(warm ? 1 : 0).map(trace => trace.liveDispatch ?? null),
      results: result.items.map(({ id, status, reason }) => ({ id, status, reason })),
      retries: stats.retries, pendingItems: stats.pendingItems };
  } finally { engine.dispose(); }
}
const scenarios = [];
for (const condition of [
  { name: 'cold-short-slow', warm: false, budgetMs: 300, responseMs: 800 },
  { name: 'learned-short-slow', warm: true, budgetMs: 300, responseMs: 800 },
  { name: 'learned-viable', warm: true, budgetMs: 1000, responseMs: 800 },
  { name: 'learned-short-fast', warm: true, budgetMs: 300, responseMs: 100 },
  { name: 'learned-single-short', warm: true, budgetMs: 300, responseMs: 800, count: 1 },
]) scenarios.push(await observe(condition));
const sizes = row => row.injectedFetches.map(call => call.items).join(',');
const patternObserved = sizes(scenarios[0]) === '2' && sizes(scenarios[1]) === '1,1'
  && sizes(scenarios[2]) === '2' && sizes(scenarios[3]) === '1,1' && sizes(scenarios[4]) === '1';
const groupedObserved = scenarios.slice(0, 4).every(row => sizes(row) === '2') && sizes(scenarios[4]) === '1';
const report = { capturedAt: new Date().toISOString(), status: patternObserved ? 'OBSERVED_LEARNED_BATCH_SPLITTING'
  : groupedObserved ? 'OBSERVED_SHORT_BUDGET_COALESCING' : 'OBSERVED_DIFFERENT_BEHAVIOR',
  scope: 'Deterministic public TranslationEngine with injected fetch and monotonic clock',
  realProviderRequests: 0, credentialsRead: false, scenarios,
  limitations: ['Characterizes current behavior; not a desired-behavior regression gate or real performance result.',
    'No LiveScheduler, browser IPC, display, real provider, mixed load, shared subscribers or clock stalls.',
    'One learned 800ms sample in a shared small-text/low-load bucket is not a calibrated latency guarantee.',
    'The fast-response counterexample shows that a blanket learned-latency cutoff can discard successful translations.'],
  sourceHashes: {} };
for (const path of ['src/translation/engine.ts', 'src/translation/provider.ts', 'scripts/diagnose-live-short-budget.mjs']) {
  report.sourceHashes[path] = createHash('sha256').update(await readFile(resolve(path))).digest('hex');
}
const root = resolve('.artifacts/live/short-budget-diagnosis'); await mkdir(root, { recursive: true });
const output = resolve(await mkdtemp(resolve(root, 'run-')), 'report.json');
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: output, status: report.status, realProviderRequests: 0,
  scenarios: scenarios.map(row => ({ name: row.name, batchSizes: row.injectedFetches.map(call => call.items), outcomes: row.results.map(item => item.status) })) }));
