import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../../src/core/config.ts';
import { resolveLocalConfig } from '../../src/local/config.ts';
import { LocalExperiment } from '../../src/diagnostics/bilibili-local-experiment.ts';

const source = '今天见到你很高兴';
const second = '明天再见';
const item = (id, text) => ({ id, text, deadlineAt: performance.now() + 5000 });
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
const zeroBudget = { maxInputItems: 0, maxInputChars: 0, maxAttempts: 0 };
const seed = (text = source, translatedText = 'It is good to see you today', sourceId = 'source-1') =>
  ({ text, translatedText, sourceRunId: 'source-run', sourceId });
const replayOptions = (f, entries = [seed()]) => {
  const options = f.options();
  return { ...options, budget: zeroBudget, cacheReplay: {
    resourceId: options.resourceId, localModelId: options.settings.localModelId,
    sourceLanguage: options.settings.sourceLanguage, targetLanguage: options.settings.targetLanguage, entries,
  }, createLocalFetch: () => { throw new Error('cache replay must never create local fetch'); } };
};

function fixture({ budget = { maxInputItems: 4, maxInputChars: 100, maxAttempts: 4 },
  allowTexts = [source, second], fetch, usage } = {}) {
  const settings = Object.freeze({ ...DEFAULT_SETTINGS, backend: 'local', enabled: false,
    localModelId: 'model-A', model: 'model-A', sourceLanguage: 'zh', targetLanguage: 'en',
    concurrency: 1, localConcurrency: 1, localPerformance: { promptMode: 'json', languageValidation: 'off' },
    requestTimeoutMs: 2000 });
  const localState = { phase: 'ready', backend: 'wllama', generation: 8,
    model: { id: 'model-A', name: 'C:\\private\\model.gguf' }, runtime: resolveLocalConfig() };
  let configVersion = 7, modelGeneration = 8, ordinaryIdle = true, sends = 0, checks = 0;
  const localFetch = fetch ?? (async (_url, init) => {
    sends++;
    const body = JSON.parse(init.body);
    const rows = JSON.parse(body.messages.at(-1).content).items;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ items: rows.map(row =>
      ({ id: row.id, text: `Translated ${row.text.length} characters` })) }) }, finish_reason: 'stop' }],
      ...(usage ? { usage } : {}) });
  });
  const options = () => ({ settings, configVersion: 7, localState, resourceId: 'av2:cid62131',
    runId: 'experiment-1', allowTexts, budget,
    assertCurrent: async () => {
      checks++;
      if (configVersion !== 7 || modelGeneration !== 8 || !ordinaryIdle) throw new Error('changed');
    },
    createLocalFetch: modelId => { assert.equal(modelId, 'model-A'); return localFetch; } });
  return { options, settings, localState,
    get sends() { return sends; }, get checks() { return checks; },
    changeConfig() { configVersion++; }, changeModel() { modelGeneration++; }, setOrdinaryBusy() { ordinaryIdle = false; } };
}

test('only disabled, loaded, matching local state and a bounded allowlist can start', async () => {
  const f = fixture();
  assert.throws(() => new LocalExperiment({ ...f.options(), settings: { ...f.settings } }), /invalid-local-experiment-context/);
  assert.throws(() => new LocalExperiment({ ...f.options(), localState: { ...f.localState, phase: 'idle' } }), /invalid-local-experiment-context/);
  assert.throws(() => new LocalExperiment({ ...f.options(), localState: { ...f.localState, model: { id: 'other' } } }), /invalid-local-experiment-context/);
  assert.throws(() => new LocalExperiment({ ...f.options(), budget: { maxInputItems: 0, maxInputChars: 10, maxAttempts: 1 } }), /invalid-local-experiment-budget/);
  const experiment = new LocalExperiment(f.options());
  await experiment.start();
  await assert.rejects(experiment.translate([item('outside', 'not in the selected window')]), /input-outside-allowlist/);
  assert.equal(f.sends, 0);
  experiment.stop();
});

test('pre-send gate blocks oversized input, then closes at the exact actual-send budget', async () => {
  const rejected = fixture({ budget: { maxInputItems: 1, maxInputChars: 2, maxAttempts: 2 } });
  const experiment = new LocalExperiment(rejected.options()); await experiment.start();
  const blocked = await experiment.translate([item('a', source)]);
  assert.equal(blocked.items[0].status, 'failed');
  assert.equal(rejected.sends, 0);
  assert.equal(experiment.snapshot().budgetReason, 'max-input-chars');
  assert.equal(experiment.snapshot().providerCalls, 0);
  experiment.stop();

  const f = fixture({ budget: { maxInputItems: 1, maxInputChars: 100, maxAttempts: 2 } });
  const run = new LocalExperiment(f.options()); await run.start();
  const ready = [];
  const result = await run.translate([item('a', source)], undefined, 'near', output => ready.push(output));
  assert.equal(result.items[0].status, 'translated');
  assert.equal(ready.length, 1);
  assert.equal(f.sends, 1);
  assert.equal(run.snapshot().budgetReason, null);
  assert.equal(run.snapshot().budgetAtLimit, 'max-input-items');
  assert.equal(run.snapshot().incomplete, true);
  assert.equal((await run.translate([item('b', second)])).items[0].status, 'failed');
  const report = run.snapshot();
  assert.equal(report.budgetReason, 'max-input-items');
  assert.equal(report.incomplete, true);
  assert.equal(report.sentInputItems, 1);
  assert.equal(report.sentInputChars, source.length);
  assert.equal(report.usage, null);
  assert.deepEqual(report.providerAttempts[0].inputs.map(row => row.text), [source]);
  assert.ok(report.providerAttempts[0].finishedAt >= report.providerAttempts[0].startedAt);
  assert.ok(report.engine.recentTrace.some(event => event.type === 'attempt'));
  assert.ok(!JSON.stringify(report).includes('C:\\private') && !JSON.stringify(report).includes('endpoint'));
  run.stop();
});

test('range completion below every budget limit reports complete without a rejection', async () => {
  const f = fixture();
  const experiment = new LocalExperiment(f.options()); await experiment.start();
  assert.equal((await experiment.translate([item('a', source)])).items[0].status, 'translated');
  experiment.stop('range-complete');
  const report = experiment.snapshot();
  assert.equal(report.budgetAtLimit, null);
  assert.equal(report.budgetReason, null);
  assert.equal(report.incomplete, false);
});

test('same text shares in-flight work and per-run memory cache; A/B instances do not share it', async () => {
  const f = fixture({ budget: { maxInputItems: 3, maxInputChars: 100, maxAttempts: 3 }, usage: { prompt_tokens: 3, completion_tokens: 2 } });
  const a = new LocalExperiment(f.options()); await a.start();
  const first = await a.translate([item('a', source), item('b', source)]);
  assert.deepEqual(first.items.map(output => output.status), ['translated', 'translated']);
  await flush();
  assert.equal((await a.translate([item('c', source)])).items[0].status, 'cached');
  assert.equal(f.sends, 1);
  assert.equal(a.snapshot().uniqueOriginalTexts, 1);
  assert.equal(a.snapshot().usage.promptTokens, 3);
  assert.equal(a.snapshot().engine.mergedInputs, 1);

  const b = new LocalExperiment({ ...f.options(), runId: 'experiment-2' }); await b.start();
  assert.equal((await b.translate([item('d', source)])).items[0].status, 'translated');
  assert.equal(f.sends, 2);
  a.stop(); b.stop();
});

test('config/model/ordinary-engine changes stop a run before another local provider send', async () => {
  for (const mutate of ['changeConfig', 'changeModel', 'setOrdinaryBusy']) {
    const f = fixture();
    const experiment = new LocalExperiment(f.options()); await experiment.start();
    assert.equal((await experiment.translate([item('a', source)])).items[0].status, 'translated');
    f[mutate]();
    await assert.rejects(experiment.translate([item('b', second)]), /context-changed/);
    assert.equal(f.sends, 1);
    assert.equal(experiment.snapshot().stopReason, 'context-changed');
  }
});

test('a change discovered at the provider gate blocks the first send', async () => {
  const f = fixture();
  const options = f.options();
  const assertCurrent = options.assertCurrent;
  let checks = 0;
  options.assertCurrent = async () => {
    if (++checks === 3) f.changeModel(); // start, translate admission, provider boundary
    await assertCurrent();
  };
  const experiment = new LocalExperiment(options); await experiment.start();
  const result = await experiment.translate([item('a', source)]);
  assert.equal(result.items[0].status, 'original');
  assert.equal(f.sends, 0);
  assert.equal(experiment.snapshot().stopReason, 'context-changed');
});

test('a failed local attempt and its retry each consume the actual-send budget', async () => {
  let sends = 0;
  const f = fixture({ budget: { maxInputItems: 2, maxInputChars: source.length * 2, maxAttempts: 2 },
    fetch: async (_url, init) => {
      sends++;
      if (sends === 1) return new Response('{}', { status: 503 });
      const rows = JSON.parse(JSON.parse(init.body).messages.at(-1).content).items;
      return Response.json({ choices: [{ message: { content: JSON.stringify({ items: rows.map(row =>
        ({ id: row.id, text: 'This is translated text' })) }) }, finish_reason: 'stop' }] });
    } });
  const experiment = new LocalExperiment(f.options()); await experiment.start();
  const result = await experiment.translate([item('a', source)]);
  assert.equal(result.items[0].status, 'translated');
  const report = experiment.snapshot();
  assert.equal(sends, 2);
  assert.equal(report.providerCalls, 2);
  assert.equal(report.sentInputChars, source.length * 2);
  assert.equal(report.repeatedInputs, 1);
  assert.equal(report.providerAttempts[0].status, 'failed');
  assert.equal(report.providerAttempts[1].status, 'completed');
  assert.equal(report.budgetAtLimit, 'max-attempts');
  assert.equal(report.budgetReason, null);
  experiment.stop('range-complete');
  assert.equal(experiment.snapshot().incomplete, true);
});

test('stop aborts this run’s in-flight local request and keeps usage unknown', async () => {
  let sent;
  const waiting = new Promise(resolve => { sent = resolve; });
  const f = fixture({ fetch: (_url, init) => {
    sent();
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () =>
      reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  } });
  const experiment = new LocalExperiment(f.options()); await experiment.start();
  const pending = experiment.translate([item('a', source)]);
  await waiting;
  experiment.stop('manual');
  const result = await pending;
  assert.ok(['original', 'failed'].includes(result.items[0].status));
  assert.equal(experiment.snapshot().state, 'stopped');
  assert.equal(experiment.snapshot().usage, null);
  assert.equal(experiment.snapshot().providerCalls, 1);
});

test('cache replay uses normal per-item cache callbacks, with zero transport and auditable provenance', async () => {
  const f = fixture();
  const experiment = new LocalExperiment(replayOptions(f, [seed(), seed(second, 'See you tomorrow', 'source-2')]));
  await experiment.start();
  const callbacks = [];
  const response = await experiment.translate([item('a', source), item('b', second)], undefined, 'near',
    output => callbacks.push(output));
  assert.deepEqual(response.items.map(row => [row.id, row.status, row.text]), [
    ['a', 'cached', 'It is good to see you today'], ['b', 'cached', 'See you tomorrow'],
  ]);
  assert.deepEqual(callbacks.map(row => row.id).sort(), ['a', 'b']);
  assert.ok(callbacks.every(row => row.status === 'cached'));
  assert.equal(f.sends, 0);
  experiment.stop('range-complete');
  const report = experiment.snapshot();
  assert.equal(report.incomplete, false);
  assert.equal(report.budgetAtLimit, null);
  assert.equal(report.budgetReason, null);
  assert.equal(report.providerCalls, 0);
  assert.equal(report.engine.providerCalls, 0);
  assert.equal(report.engine.cacheHits, 2);
  assert.equal(report.safety.transport, 'cache-only');
  assert.equal(report.safety.modelMatched, true);
  assert.deepEqual(report.cacheReplay, { seededEntries: 2, cacheMisses: 0,
    sources: [{ sourceRunId: 'source-run', sourceId: 'source-1' },
      { sourceRunId: 'source-run', sourceId: 'source-2' }] });
});

test('cache misses hard-fail without a fetch or retry, and leave exact budget unused', async () => {
  const f = fixture();
  const experiment = new LocalExperiment(replayOptions(f)); await experiment.start();
  const callbacks = [];
  const response = await experiment.translate([item('known', source), item('missing', second)],
    undefined, 'near', output => callbacks.push(output));
  assert.deepEqual(response.items.map(row => row.status), ['cached', 'failed']);
  assert.equal(response.items[1].reason, 'local-experiment-cache-miss');
  assert.deepEqual(callbacks.map(row => row.id).sort(), ['known', 'missing']);
  const report = experiment.snapshot();
  assert.equal(report.cacheReplay.cacheMisses, 1);
  assert.equal(report.failedResults, 1);
  assert.equal(report.incomplete, true);
  assert.equal(report.engine.retries, 0);
  assert.equal(report.providerCalls, 0);
  assert.equal(report.budgetAtLimit, null);
  assert.equal(f.sends, 0);
  experiment.stop('range-complete');
});

test('cache replay rejects mismatched metadata, source, unsafe translation, conflict and nonzero budget', () => {
  const f = fixture();
  const base = replayOptions(f);
  const reject = (changes, pattern = /invalid-local-experiment-cache-replay/) =>
    assert.throws(() => new LocalExperiment({ ...base, ...changes }), pattern);
  for (const [name, value] of [['resourceId', 'other'], ['localModelId', 'other'],
    ['sourceLanguage', 'ja'], ['targetLanguage', 'ja']]) {
    reject({ cacheReplay: { ...base.cacheReplay, [name]: value } });
  }
  reject({ cacheReplay: { ...base.cacheReplay, entries: [] } });
  reject({ cacheReplay: { ...base.cacheReplay, entries: Array.from({ length: 101 }, () => seed()) } });
  reject({ cacheReplay: { ...base.cacheReplay, entries: [seed('outside')] } });
  reject({ cacheReplay: { ...base.cacheReplay, entries: [seed(source, ' ')] } });
  reject({ cacheReplay: { ...base.cacheReplay, entries: [seed(source, 'X'.repeat(2001))] } });
  reject({ cacheReplay: { ...base.cacheReplay, entries: [seed(source, 'Preserve every placeholder exactly, in order and count.')] } });
  reject({ cacheReplay: { ...base.cacheReplay, entries: [{ ...seed(), sourceRunId: '' }] } });
  reject({ cacheReplay: { ...base.cacheReplay, entries: [{ ...seed(), sourceId: 'x'.repeat(1001) }] } });
  reject({ cacheReplay: { ...base.cacheReplay, entries: [seed(), seed(source, 'A different translation')] } },
    /conflicting-local-experiment-cache-replay/);
  for (const name of Object.keys(zeroBudget))
    reject({ budget: { ...zeroBudget, [name]: 1 } }, /invalid-local-experiment-budget/);
  reject({ localState: { ...f.localState, generation: -Infinity } }, /invalid-local-experiment-context/);
});

test('cache replay accepts unloaded idle state and isolates seeds between instances', async () => {
  const f = fixture();
  const state = { ...f.localState, phase: 'idle', model: undefined, runtime: undefined };
  const a = new LocalExperiment({ ...replayOptions(f), localState: state, runId: 'replay-a' }); await a.start();
  assert.equal((await a.translate([item('a', source)])).items[0].status, 'cached');
  const report = a.snapshot();
  assert.equal(report.safety.modelMatched, false);
  assert.equal(report.safety.runtimeParallel, null);
  assert.equal(report.safety.runtimeContextTokens, null);
  assert.equal(report.safety.modelLoads, 0);
  const b = new LocalExperiment({ ...replayOptions(f, [seed(second, 'See you tomorrow')]),
    localState: state, runId: 'replay-b' }); await b.start();
  assert.equal((await b.translate([item('b', source)])).items[0].reason, 'local-experiment-cache-miss');
  assert.equal((await b.translate([item('c', second)])).items[0].status, 'cached');
  assert.equal(f.sends, 0);
  a.stop(); b.stop();
});

test('config change interrupts cache replay even when its entry is already seeded', async () => {
  const f = fixture();
  const experiment = new LocalExperiment(replayOptions(f)); await experiment.start();
  f.changeConfig();
  await assert.rejects(experiment.translate([item('a', source)]), /context-changed/);
  const report = experiment.snapshot();
  assert.equal(report.stopReason, 'context-changed');
  assert.equal(report.providerCalls, 0);
  assert.equal(f.sends, 0);
});
