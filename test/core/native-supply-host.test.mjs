import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../../src/core/config.ts';
import { normalizeLocalConfig, resolveLocalConfig } from '../../src/local/config.ts';
import { setProviderTransportGuard, ProviderError } from '../../src/translation/provider.ts';
import { MemoryTranslationCache, translationCacheKey } from '../../src/translation/cache.ts';
import { TranslationEngine } from '../../src/translation/engine.ts';
import { LivePreviewBudget } from '../../src/diagnostics/live-preview-budget.ts';
import { LivePreviewHost, LIVE_PREVIEW_RESOURCE, NATIVE_SUPPLY_BUDGET_KEY,
  NATIVE_SUPPLY_GRANT_KEY, NATIVE_SUPPLY_GUARD_KEY, strictNativeResultIssue } from '../../src/diagnostics/live-preview-host.ts';
import { BilibiliNativeSupply } from '../../src/platforms/bilibili/native-supply.ts';

const clone = value => value === undefined ? undefined : structuredClone(value);
const MODEL = { id: 'registered-hy-7b', name: 'Hy-MT2-7B-Q4_K_M', files: ['Hy-MT2-7B-Q4_K_M.gguf'],
  bytes: 4_624_648_896, architecture: 'hunyuan-dense', quantization: 'Q4_K_M', tokenizer: 'fixture',
  template: true, importedAt: 1, availability: 'ready', metadataVersion: 1, metadataComplete: true };
const SESSION = { platform: 'bilibili', scenario: 'video', resourceId: LIVE_PREVIEW_RESOURCE,
  sessionId: 'native-fixture', generation: 2 };
const runtime = { ...resolveLocalConfig({ mode: 'custom', warmup: false, parallel: 2, promptMode: 'auto' }),
  contextTokens: 4096, kvUnified: true, continuousBatching: true };
const demand = (id, text = '你好', epoch = 3) => ({ id, sourceId: `source-${id}`, originalText: text,
  mediaTimeMs: 4_000, deadlineAtEpochMs: Date.now() + 30_000, epoch, predictionEpoch: 7, ruleRevision: 1 });

function harness({ cpuThreadsActual } = {}) {
  const values = new Map(), pageMessages = [], bodies = [];
  let currentDemand = demand('d1');
  let session = clone(SESSION);
  let buildId = 'native-build', documentId = 'native-document', configVersion = 2, tabId = 41;
  let modelState = { phase: 'idle', generation: 0, inferenceCalls: 0, active: 0, queued: 0 };
  let outputText = 'こんにちは', sends = 0, loads = 0, unloads = 0, failLoad = false;
  const settings = { ...DEFAULT_SETTINGS, enabled: false, backend: 'local', localModelId: 'other-model' };
  const storage = {
    async get(keys) { return Object.fromEntries((typeof keys === 'string' ? [keys] : keys)
      .map(key => [key, clone(values.get(key))])); },
    async set(record) { for (const [key, value] of Object.entries(record)) values.set(key, clone(value)); },
    async remove(key) { values.delete(key); },
  };
  let host;
  const newHost = () => new LivePreviewHost({ purpose: 'native-supply', buildId, storage,
    context: async requestedTabId => requestedTabId === tabId ? ({ settings: clone(settings), configVersion, tabId,
      documentId, session: clone(session), idle: true }) : null,
    localControl: async request => {
      if (request.action === 'list') return { ok: true, models: [clone(MODEL)], state: clone(modelState) };
      if (request.action === 'state') return { ok: true, state: clone(modelState) };
      if (request.action === 'load') {
        loads++;
        if (failLoad) { failLoad = false; throw new Error('unknown-load-outcome'); }
        assert.equal(request.modelId, MODEL.id);
        assert.equal(request.config.warmup, false);
        assert.equal(request.config.normalMaxTokens, 128);
        assert.equal(request.config.mode, 'custom');
        assert.equal(resolveLocalConfig(request.config, MODEL.id).parallel, 2);
        modelState = { ...modelState, phase: 'ready', model: clone(MODEL), generation: modelState.generation + 1,
          runtime: { ...resolveLocalConfig(request.config, MODEL.id),
            kvUnified: true, continuousBatching: true,
            ...(cpuThreadsActual === undefined ? {} : { cpuThreadsActual }) }, warmupMs: 0 };
        return { ok: true, state: clone(modelState) };
      }
      if (request.action === 'unload') { unloads++; modelState = { ...modelState, phase: 'idle',
        model: undefined, runtime: undefined, generation: modelState.generation + 1 };
        return { ok: true, state: clone(modelState) }; }
      throw new Error('unexpected control');
    },
    page: async (_tabId, _documentId, message) => {
      pageMessages.push(clone(message));
      if (message.type === 'bilibili-native-supply-proof') return { ok: true, buildId,
        runId: message.runId, instanceId: message.instanceId, epoch: message.epoch, session: clone(session),
        contextValid: true, visible: true,
        clock: { mediaTimeMs: 1_000, paused: false, seeking: false, playbackRate: 1, contentActive: true },
        demands: [clone(currentDemand)] };
      return { ok: true };
    },
    createLocalFetch: (_id, gate) => async (_url, init) => {
      await gate.beforeSend(`attempt-${++sends}`, init.signal);
      gate.sent?.(`attempt-${sends}`);
      bodies.push(JSON.parse(init.body));
      modelState.inferenceCalls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: outputText }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    },
    globalIdle: async () => true,
  });
  host = newHost();
  setProviderTransportGuard(async context => {
    if (!await host.acceptsTransport(context)) throw new ProviderError('native-test-guard-rejected');
  });
  const prepare = () => host.prepare({ taskId: 'native-task', runId: 'native-run', phase: 'main',
    tabId: 41, epoch: 3, fromMs: 0, toMs: 45_000, modelId: MODEL.id });
  const translate = (grant, item = currentDemand, requestId = 'request-1') => host.translate(tabId, documentId, {
    runId: grant.runId, instanceId: grant.instanceId, epoch: item.epoch, requestId,
    items: [{ ...item, text: item.originalText }],
  });
  return { get host() { return host; }, values, pageMessages, bodies, prepare, translate,
    restart({ nextBuildId = 'native-rebuilt', nextDocumentId = 'native-new-document',
      nextConfigVersion = 0, nextTabId = tabId } = {}) {
      buildId = nextBuildId; documentId = nextDocumentId; configVersion = nextConfigVersion; tabId = nextTabId;
      host = newHost(); return host;
    },
    setDemand(value) { currentDemand = value; }, setOutput(value) { outputText = value; },
    setSettings(value) { Object.assign(settings, value); }, failNextLoad() { failLoad = true; },
    setSession(value) { session = clone(value); },
    setModelState(value) { modelState = clone(value); },
    get sends() { return sends; }, get loads() { return loads; }, get unloads() { return unloads; } };
}
async function seedInterruptedAutoPreparation(h, { modelStillReady = true, retainBudget = false } = {}) {
  const prepared = await h.prepare();
  const prior = clone(h.values.get(NATIVE_SUPPLY_GRANT_KEY));
  const autoRuntime = { ...resolveLocalConfig({ mode: 'auto', parallel: 2,
    normalMaxTokens: 128, promptMode: 'auto', warmup: false }, MODEL.id),
    kvUnified: true, continuousBatching: true };
  assert.equal(autoRuntime.parallel, 4, 'fixture must reproduce the actual auto override');
  prior.state = 'preparing'; prior.configIdentity = '';
  prior.modelAfterLoad.runtime = autoRuntime;
  h.values.set(NATIVE_SUPPLY_GRANT_KEY, prior);
  if (!retainBudget) h.values.delete(NATIVE_SUPPLY_BUDGET_KEY);
  h.setModelState(modelStillReady ? { phase: 'ready', generation: prior.modelGeneration,
    model: MODEL, runtime: autoRuntime, inferenceCalls: 0, active: 0, queued: 0,
    warmupMs: 0 } : { phase: 'idle', generation: 0,
    inferenceCalls: 0, active: 0, queued: 0 });
  h.setSession({ ...SESSION, generation: 3 });
  h.restart();
  return { prior, initialLoads: h.loads, initialUnloads: h.unloads };
}

async function seedCleanedRecoveredMain(h) {
  await seedInterruptedAutoPreparation(h, { modelStillReady: false });
  const recovered = await h.host.prepare({ taskId: 'native-task', runId: 'native-run', phase: 'main',
    tabId: 41, epoch: 4, fromMs: 0, toMs: 45_000, modelId: MODEL.id });
  assert.equal(recovered.grant.modelLoads, 2);
  assert.equal(recovered.grant.loadRecoveryCount, 1);
  await h.host.cleanup();
  assert.equal(h.values.has(NATIVE_SUPPLY_GUARD_KEY), false);
  const oldHost = h.host;
  const originalBudget = clone(h.values.get(NATIVE_SUPPLY_BUDGET_KEY));
  assert.equal(originalBudget.phaseRuns.main, 'native-run');
  assert.equal(originalBudget.phaseRuns.repair, null);
  assert.equal(originalBudget.attempts.length, 0);
  h.setSession({ ...SESSION, generation: 4 });
  h.restart({ nextBuildId: 'native-repair-build', nextDocumentId: 'native-repair-document', nextTabId: 42 });
  return { originalBudget, oldGrant: clone(h.values.get(NATIVE_SUPPLY_GRANT_KEY)), oldHost };
}

const authorizedRepair = (overrides = {}) => ({ taskId: 'native-task', runId: 'repair-run', phase: 'repair',
  repairReason: 'bounded correction after cleanup', tabId: 42, epoch: 5,
  fromMs: 0, toMs: 15_000, modelId: MODEL.id, authorizedExtraLoad: true, ...overrides });
afterEach(() => setProviderTransportGuard());

test('strict policy rejects unchanged, invalid placeholders, and obvious non-target text', () => {
  const settings = { ...DEFAULT_SETTINGS, backend: 'local', targetLanguage: 'ja',
    localPerformance: { languageValidation: 'strict' } };
  assert.equal(strictNativeResultIssue('你好', '你好', settings), 'unchanged-output');
  assert.equal(strictNativeResultIssue('[[DL:x]]你好', 'こんにちは', settings), 'placeholder-mismatch');
  assert.equal(strictNativeResultIssue('Hello world', 'Another long English sentence', settings), 'wrong-target-language');
  assert.equal(strictNativeResultIssue('你好', 'こんにちは', settings), null);
});

test('native grant sends exactly one qualified result and replays from memory without a model send', async () => {
  const h = harness();
  const prepared = await h.prepare();
  assert.equal(prepared.grant.modelId, MODEL.id);
  assert.equal(h.values.get(NATIVE_SUPPLY_GUARD_KEY).kind, 'native-supply');
  assert.equal(h.values.has(NATIVE_SUPPLY_GRANT_KEY), true);
  await h.host.start(41, 'native-document', 'native-run', prepared.grant.instanceId);
  const first = await h.translate(prepared.grant);
  assert.equal(first.items[0].status, 'translated');
  assert.equal(first.items[0].nativeSupply.kind, 'new-inference');
  assert.equal(h.bodies[0].max_tokens, 128);
  assert.equal(h.sends, 1);
  assert.equal(h.pageMessages.at(-1).type, 'bilibili-native-supply-result');
  assert.equal(h.pageMessages.at(-1).sourceId, 'source-d1');
  await h.host.stop();
  h.setSession({ ...SESSION, generation: 3 });
  const replay = await h.host.replay(41, 'native-document', {
    runId: 'native-run', instanceId: prepared.grant.instanceId, epoch: 4 });
  assert.notEqual(replay.grant.instanceId, prepared.grant.instanceId);
  assert.equal(replay.grant.cacheOnly, true);
  assert.equal(replay.grant.session.generation, 3);
  await h.host.start(41, 'native-document', 'native-run', replay.grant.instanceId);
  const secondDemand = demand('d2', '你好', 4);
  h.setDemand(secondDemand);
  const second = await h.translate(replay.grant, secondDemand, 'request-2');
  assert.equal(second.items[0].status, 'cached');
  assert.equal(second.items[0].nativeSupply.kind, 'session-cache');
  const delivered = h.pageMessages.at(-1);
  assert.equal(delivered.type, 'bilibili-native-supply-result');
  assert.equal(Object.hasOwn(delivered.output.nativeSupply, 'resultId'), false);
  assert.equal(Object.hasOwn(delivered.output.nativeSupply, 'taskId'), false);
  const gate = new BilibiliNativeSupply({ resourceId: LIVE_PREVIEW_RESOURCE, session: 'native-fixture',
    now: () => performance.now(), epochNow: () => Date.now(), emit: () => {}, pause: () => {} });
  gate.configure({ enabled: true, runId: replay.grant.runId, instanceId: replay.grant.instanceId,
    configIdentity: replay.grant.configIdentity, sourceLanguage: 'auto', targetLanguage: 'ja',
    fromMs: 0, toMs: 45_000, state: 'running' });
  gate.updatePrediction({ known: true, active: true, epoch: 4, predictionEpoch: 7, ruleRevision: 1,
    items: [{ id: secondDemand.id, originalText: secondDemand.originalText }] });
  const source = { id: secondDemand.id, sourceId: secondDemand.sourceId,
    originalText: secondDemand.originalText };
  const preparedResult = { ...delivered.output.nativeSupply, ...secondDemand,
    text: delivered.output.text, status: delivered.output.status };
  assert.equal(gate.acceptPrepared(preparedResult, source, 4), true);
  assert.equal(gate.select({ ...source, mode: 1, canReplace: true, epoch: 4,
    mediaTimeMs: secondDemand.mediaTimeMs }).choice, 'adopted');
  assert.equal(h.sends, 1);
  const missing = demand('d3', '不同的原文', 4);
  h.setDemand(missing);
  const miss = await h.translate(replay.grant, missing, 'request-3');
  assert.equal(miss.items[0].reason, 'cache-miss');
  assert.equal(h.sends, 1);
  assert.equal((await h.host.status()).budget.total.actualSent.requests, 1);
  assert.equal(h.values.get(NATIVE_SUPPLY_BUDGET_KEY).attempts.length, 1);
});

test('invalidated proof and unchanged output cannot qualify or spend another attempt', async () => {
  const h = harness();
  const prepared = await h.prepare();
  await h.host.start(41, 'native-document', 'native-run', prepared.grant.instanceId);
  const stale = demand('d1');
  h.setDemand(demand('another'));
  await assert.rejects(h.translate(prepared.grant, stale), /no-current-demand/);
  assert.equal(h.sends, 0);
  h.setDemand(demand('d1'));
  h.setOutput('你好');
  const result = await h.translate(prepared.grant);
  assert.equal(result.items[0].status, 'failed');
  assert.equal(result.items[0].reason, 'unchanged-output');
  assert.equal(h.pageMessages.at(-1).output.nativeSupply, undefined);
  assert.equal(h.sends, 1);
});

test('a preloaded 7B with the wrong runtime cannot silently change the measured configuration', async () => {
  const h = harness();
  h.setModelState({ phase: 'ready', model: MODEL, generation: 3, inferenceCalls: 0,
    active: 0, queued: 0, runtime: { ...runtime, parallel: 1, normalMaxTokens: 256 } });
  await assert.rejects(h.prepare(), /native-model-runtime-mismatch/);
  assert.equal(h.values.has(NATIVE_SUPPLY_GRANT_KEY), false);
});

test('same-task zero-call preparation recovery rebinds a new build and reloads an owned auto-mode model once', async () => {
  const h = harness();
  const { prior, initialLoads, initialUnloads } = await seedInterruptedAutoPreparation(h);
  const recovered = await h.host.prepare({ taskId: 'native-task', runId: 'native-run', phase: 'main',
    tabId: 41, epoch: 4, fromMs: 0, toMs: 45_000, modelId: MODEL.id });
  assert.equal(recovered.grant.state, 'prepared');
  assert.equal(recovered.grant.taskId, prior.taskId);
  assert.equal(recovered.grant.runId, prior.runId);
  assert.equal(recovered.grant.buildId, 'native-rebuilt');
  assert.equal(recovered.grant.documentId, 'native-new-document');
  assert.equal(recovered.grant.epoch, 4);
  assert.notEqual(recovered.grant.instanceId, prior.instanceId);
  assert.deepEqual(recovered.grant.modelBaseline, prior.modelBaseline);
  assert.equal(recovered.grant.modelLoads, 2);
  assert.equal(recovered.grant.loadRecoveryCount, 1);
  assert.equal(recovered.grant.modelAfterLoad.runtime.mode, 'custom');
  assert.equal(recovered.grant.modelAfterLoad.runtime.parallel, 2);
  assert.equal(recovered.grant.modelAfterLoad.runtime.normalMaxTokens, 128);
  assert.equal(h.unloads, initialUnloads + 1);
  assert.equal(h.loads, initialLoads + 1);
  assert.equal(h.sends, 0);
  assert.equal(recovered.budget.total.occupied.requests, 0);
  assert.equal(recovered.budget.total.actualSent.requests, 0);
  const repeated = await h.host.prepare({ taskId: 'native-task', runId: 'native-run', phase: 'main',
    tabId: 41, epoch: 4, fromMs: 0, toMs: 45_000, modelId: MODEL.id });
  assert.equal(repeated.grant.instanceId, recovered.grant.instanceId);
  assert.equal(h.loads, initialLoads + 1);
  h.restart();
  await assert.rejects(h.host.prepare({ taskId: 'native-task', runId: 'native-run', phase: 'main',
    tabId: 41, epoch: 4, fromMs: 0, toMs: 45_000, modelId: MODEL.id }), /recovery-required/);
  assert.equal(h.loads, initialLoads + 1);
});

test('an offscreen reset can recover the same zero-call preparation from idle without unloading', async () => {
  const h = harness();
  const { prior, initialLoads, initialUnloads } = await seedInterruptedAutoPreparation(h, { modelStillReady: false });
  const recovered = await h.host.prepare({ taskId: 'native-task', runId: 'native-run', phase: 'main',
    tabId: 41, epoch: 4, fromMs: 0, toMs: 45_000, modelId: MODEL.id });
  assert.equal(recovered.grant.modelLoads, 2);
  assert.equal(recovered.grant.loadRecoveryCount, 1);
  assert.deepEqual(recovered.grant.modelBaseline, prior.modelBaseline);
  assert.equal(recovered.grant.modelAfterLoad.runtime.parallel, 2);
  assert.equal(h.unloads, initialUnloads);
  assert.equal(h.loads, initialLoads + 1);
  assert.equal(h.sends, 0);
});

test('preparation recovery rejects prior inference, occupied budget, and a different guard owner', async () => {
  for (const mismatch of ['inference', 'budget', 'owner']) {
    const h = harness();
    const { initialLoads, initialUnloads } = await seedInterruptedAutoPreparation(h, { retainBudget: mismatch === 'budget' });
    if (mismatch === 'inference') h.setModelState({ phase: 'ready', generation: 1,
      model: MODEL, runtime: { ...resolveLocalConfig({ mode: 'auto', parallel: 2,
        normalMaxTokens: 128, warmup: false }, MODEL.id), kvUnified: true, continuousBatching: true },
      inferenceCalls: 1, active: 0, queued: 0 });
    if (mismatch === 'budget') {
      const budget = h.values.get(NATIVE_SUPPLY_BUDGET_KEY);
      budget.attempts.push({ attemptId: 'already-used', phase: 'main', runId: 'native-run',
        items: [{ id: 'prior', utf16Length: 2 }], status: 'sent' });
      h.values.set(NATIVE_SUPPLY_BUDGET_KEY, budget);
    }
    if (mismatch === 'owner') h.values.set(NATIVE_SUPPLY_GUARD_KEY,
      { enabled: true, kind: 'native-supply', tabId: 41, runId: 'foreign-run' });
    await assert.rejects(h.host.prepare({ taskId: 'native-task', runId: 'native-run', phase: 'main',
      tabId: 41, epoch: 4, fromMs: 0, toMs: 45_000, modelId: MODEL.id }),
    /native-preparation-(model-changed|recovery-unavailable)/);
    assert.equal(h.loads, initialLoads);
    assert.equal(h.unloads, initialUnloads);
    assert.equal(h.sends, 0);
  }
});

test('extension retirement of an unused preparation preserves its single recovery; manual stop does not', async () => {
  for (const reason of ['owner-tab-retired', 'manual']) {
    const h = harness();
    const { prior, initialLoads } = await seedInterruptedAutoPreparation(h, { modelStillReady: false });
    h.values.set(NATIVE_SUPPLY_GRANT_KEY, { ...prior, state: 'stopped', reason });
    const action = h.host.prepare({ taskId: 'native-task', runId: 'native-run', phase: 'main',
      tabId: 41, epoch: 4, fromMs: 0, toMs: 45_000, modelId: MODEL.id });
    if (reason === 'manual') {
      await assert.rejects(action, /main-already-used/); assert.equal(h.loads, initialLoads);
    } else {
      const recovered = await action;
      assert.equal(recovered.grant.modelLoads, 2); assert.equal(recovered.grant.loadRecoveryCount, 1);
      assert.equal(recovered.grant.state, 'prepared'); assert.equal(h.loads, initialLoads + 1);
    }
    assert.equal(h.sends, 0);
  }
});

test('one bounded repair run retains model ownership, cache, and cumulative budget', async () => {
  const h = harness();
  const first = await h.prepare();
  await h.host.start(41, 'native-document', 'native-run', first.grant.instanceId);
  await h.translate(first.grant);
  await h.host.stop();
  h.setSession({ ...SESSION, generation: 3 });
  const repaired = await h.host.prepare({ taskId: 'native-task', runId: 'repair-run', phase: 'repair',
    repairReason: 'missed first admission', tabId: 41, epoch: 4, fromMs: 0, toMs: 10_000,
    modelId: MODEL.id });
  assert.equal(repaired.grant.modelLoads, 1);
  assert.equal(repaired.grant.loadedByTask, true);
  await h.host.start(41, 'native-document', 'repair-run', repaired.grant.instanceId);
  const secondDemand = demand('repair-d1', '你好', 4);
  h.setDemand(secondDemand);
  const answer = await h.host.translate(41, 'native-document', { runId: 'repair-run',
    instanceId: repaired.grant.instanceId, epoch: 4, requestId: 'repair-request',
    items: [{ ...secondDemand, text: secondDemand.originalText }] });
  assert.equal(answer.items[0].status, 'cached');
  assert.equal(h.sends, 1);
  assert.equal((await h.host.status()).budget.total.actualSent.requests, 1);
  await h.host.stop();
  await assert.rejects(h.host.prepare({ taskId: 'native-task', runId: 'another-repair', phase: 'repair',
    repairReason: 'again', tabId: 41, epoch: 5, fromMs: 0, toMs: 10_000, modelId: MODEL.id }),
  /repair-unavailable/);
  await h.host.cleanup();
  assert.equal(h.values.has(NATIVE_SUPPLY_GUARD_KEY), false);
  assert.equal(h.values.has(NATIVE_SUPPLY_BUDGET_KEY), true);
});

test('explicit native repair after cleanup spends exactly one third model load on a new tab/build', async () => {
  const h = harness();
  const { originalBudget, oldGrant } = await seedCleanedRecoveredMain(h);
  assert.equal(oldGrant.phase, 'main');
  assert.equal(oldGrant.state, 'stopped');
  assert.equal(oldGrant.reason, 'cleanup');
  assert.equal(h.loads, 2);
  assert.equal(h.unloads, 1);
  const repaired = await h.host.prepare(authorizedRepair());
  assert.equal(repaired.grant.state, 'prepared');
  assert.equal(repaired.grant.runId, 'repair-run');
  assert.equal(repaired.grant.previousRunId, oldGrant.runId);
  assert.equal(repaired.grant.buildId, 'native-repair-build');
  assert.equal(repaired.grant.tabId, 42);
  assert.equal(repaired.grant.documentId, 'native-repair-document');
  assert.equal(repaired.grant.modelLoads, 3);
  assert.equal(repaired.grant.loadRecoveryCount, 1);
  assert.equal(repaired.grant.modelAfterLoad.runtime.parallel, 2);
  assert.equal(repaired.grant.configIdentity, oldGrant.configIdentity);
  assert.equal(h.loads, 3);
  assert.equal(h.unloads, 1);
  assert.equal(h.sends, 0);
  assert.equal(repaired.budget.total.limits.requests, 100);
  assert.equal(repaired.budget.total.limits.items, 100);
  assert.equal(repaired.budget.total.limits.utf16Chars, 2000);
  assert.equal(repaired.budget.total.occupied.requests, 0);
  assert.equal(repaired.budget.phases.main.runId, originalBudget.phaseRuns.main);
  assert.equal(repaired.budget.phases.repair.runId, 'repair-run');
  const persistedBudget = h.values.get(NATIVE_SUPPLY_BUDGET_KEY);
  assert.deepEqual(persistedBudget.attempts, originalBudget.attempts);
  assert.deepEqual(persistedBudget.phaseRuns, { ...originalBudget.phaseRuns, repair: 'repair-run' });
  const repeated = await h.host.prepare(authorizedRepair());
  assert.equal(repeated.grant.instanceId, repaired.grant.instanceId);
  assert.equal(h.loads, 3);
  await h.host.cleanup();
  h.restart({ nextTabId: 43 });
  await assert.rejects(h.host.prepare(authorizedRepair({ tabId: 43, runId: 'second-repair' })),
    /repair-unavailable/);
  assert.equal(h.loads, 3);
});

test('retired old tab preserves cleanup reason, and a previously overwritten reason can still authorize repair', async () => {
  const h = harness();
  const { oldHost, oldGrant, originalBudget } = await seedCleanedRecoveredMain(h);
  await oldHost.stopForTab(41, 'owner-tab-retired');
  assert.equal(h.values.get(NATIVE_SUPPLY_GRANT_KEY).reason, 'cleanup');

  // Existing installations may already have persisted the old stopForTab overwrite.
  await oldHost.stop('owner-tab-retired');
  assert.equal(h.values.get(NATIVE_SUPPLY_GRANT_KEY).reason, 'owner-tab-retired');
  const repaired = await h.host.prepare(authorizedRepair());
  assert.equal(repaired.grant.state, 'prepared');
  assert.equal(repaired.grant.previousRunId, oldGrant.runId);
  assert.equal(repaired.grant.modelLoads, 3);
  assert.equal(repaired.grant.loadRecoveryCount, 1);
  assert.equal(h.loads, 3);
  assert.equal(h.sends, 0);
  assert.equal(repaired.budget.phases.main.runId, originalBudget.phaseRuns.main);
  assert.equal(repaired.budget.phases.repair.runId, 'repair-run');
  assert.deepEqual(h.values.get(NATIVE_SUPPLY_BUDGET_KEY).attempts, originalBudget.attempts);
});

test('stored runtime key sorting preserves old config identity before an authorized third load', async () => {
  const h = harness({ cpuThreadsActual: 8 });
  const { oldGrant, originalBudget } = await seedCleanedRecoveredMain(h);
  const stored = h.values.get(NATIVE_SUPPLY_GRANT_KEY);
  stored.modelAfterLoad.runtime = Object.fromEntries(Object.entries(stored.modelAfterLoad.runtime)
    .sort(([left], [right]) => left.localeCompare(right)));
  h.values.set(NATIVE_SUPPLY_GRANT_KEY, stored);
  assert.equal(stored.modelAfterLoad.runtime.cpuThreadsActual, 8);
  assert.equal(stored.configIdentity, oldGrant.configIdentity);
  const repaired = await h.host.prepare(authorizedRepair());
  assert.equal(repaired.grant.modelLoads, 3);
  assert.equal(repaired.grant.configIdentity, oldGrant.configIdentity);
  assert.equal(h.loads, 3);
  assert.deepEqual(h.values.get(NATIVE_SUPPLY_BUDGET_KEY).attempts, originalBudget.attempts);
});

test('changed stored runtime value rejects before spending the authorized third load', async () => {
  const h = harness({ cpuThreadsActual: 8 });
  await seedCleanedRecoveredMain(h);
  const stored = h.values.get(NATIVE_SUPPLY_GRANT_KEY);
  stored.modelAfterLoad.runtime.batch += 1;
  h.values.set(NATIVE_SUPPLY_GRANT_KEY, stored);
  await assert.rejects(h.host.prepare(authorizedRepair()), /repair-config-changed/);
  assert.equal(h.loads, 2);
  assert.equal(h.values.get(NATIVE_SUPPLY_GRANT_KEY).modelLoads, 2);
  assert.equal(h.values.get(NATIVE_SUPPLY_BUDGET_KEY).phaseRuns.repair, null);
});

test('extra model load is denied without exact authorization and unchanged task, settings, model, and budget', async () => {
  for (const mismatch of ['missing-authorization', 'task', 'settings', 'model', 'budget', 'occupied-budget',
    'guard', 'phase', 'window', 'old-tab', 'old-build', 'old-document', 'unknown-state']) {
    const h = harness();
    await seedCleanedRecoveredMain(h);
    let input = authorizedRepair();
    if (mismatch === 'missing-authorization') delete input.authorizedExtraLoad;
    if (mismatch === 'task') input.taskId = 'different-task';
    if (mismatch === 'settings') h.setSettings({ targetLanguage: 'en' });
    if (mismatch === 'model') input.modelId = 'different-model';
    if (mismatch === 'budget') {
      const budget = h.values.get(NATIVE_SUPPLY_BUDGET_KEY);
      budget.phaseRuns.repair = 'another-repair';
      h.values.set(NATIVE_SUPPLY_BUDGET_KEY, budget);
    }
    if (mismatch === 'occupied-budget') {
      const budget = h.values.get(NATIVE_SUPPLY_BUDGET_KEY);
      budget.attempts.push({ attemptId: 'old-input', phase: 'main', runId: 'native-run',
        items: [{ id: 'old', utf16Length: 2 }], status: 'completed' });
      h.values.set(NATIVE_SUPPLY_BUDGET_KEY, budget);
    }
    if (mismatch === 'guard') h.values.set(NATIVE_SUPPLY_GUARD_KEY,
      { enabled: true, kind: 'native-supply', tabId: 42, runId: 'another-run' });
    if (mismatch === 'phase') input.phase = 'main';
    if (mismatch === 'window') input.toMs = 15_001;
    if (mismatch === 'old-tab') input.tabId = 41;
    if (mismatch === 'old-build') h.restart({ nextBuildId: 'native-rebuilt', nextTabId: 42 });
    if (mismatch === 'old-document') h.restart({ nextDocumentId: 'native-new-document', nextTabId: 42 });
    if (mismatch === 'unknown-state') h.setModelState({ phase: 'loading', generation: 2,
      inferenceCalls: 0, active: 0, queued: 0 });
    await assert.rejects(h.host.prepare(input), undefined, mismatch);
    assert.equal(h.loads, 2, mismatch);
    assert.equal(h.sends, 0, mismatch);
    assert.equal(h.values.get(NATIVE_SUPPLY_GRANT_KEY).modelLoads, 2, mismatch);
  }
});

test('uncertain third load is durably counted and cannot be retried', async () => {
  const h = harness();
  await seedCleanedRecoveredMain(h);
  h.failNextLoad();
  await assert.rejects(h.host.prepare(authorizedRepair()), /native-repair-load-uncertain/);
  assert.equal(h.loads, 3);
  const grant = h.values.get(NATIVE_SUPPLY_GRANT_KEY);
  assert.equal(grant.phase, 'repair');
  assert.equal(grant.previousRunId, 'native-run');
  assert.equal(grant.modelLoads, 3);
  assert.equal(grant.loadRecoveryCount, 1);
  assert.equal(grant.loadOwnership, 'uncertain');
  const budget = h.values.get(NATIVE_SUPPLY_BUDGET_KEY);
  assert.equal(budget.phaseRuns.repair, null);
  assert.equal(budget.attempts.length, 0);
  h.restart({ nextTabId: 43 });
  await assert.rejects(h.host.prepare(authorizedRepair({ tabId: 43 })), /recovery-required/);
  assert.equal(h.loads, 3);
});

test('independent native budget enforces total 100/100/2000 across phases', async () => {
  let stored;
  const store = { read: async () => clone(stored), write: async value => { stored = clone(value); } };
  const limits = { total: { requests: 100, items: 100, utf16Chars: 2000 }, phases: {
    main: { requests: 100, items: 100, utf16Chars: 2000 },
    repair: { requests: 100, items: 100, utf16Chars: 2000 },
    supplement: { requests: 0, items: 0, utf16Chars: 0 },
  } };
  const budget = new LivePreviewBudget(store, limits);
  await budget.open('task', 'model', 'config');
  await budget.beginPhase('main', 'main');
  await budget.reserve({ phase: 'main', runId: 'main', attemptId: 'a', items: [{ id: 'one', text: 'x'.repeat(1999) }] });
  await budget.beginPhase('repair', 'repair', 'finite correction');
  await budget.reserve({ phase: 'repair', runId: 'repair', attemptId: 'b', items: [{ id: 'two', text: 'z' }] });
  await assert.rejects(budget.reserve({ phase: 'repair', runId: 'repair', attemptId: 'c',
    items: [{ id: 'three', text: 'x' }] }), /exceeds its limit/);
  assert.equal(budget.snapshot().total.occupied.utf16Chars, 2000);
});

test('strict engine rejects an unchanged cache row and makes at most one provider attempt', async () => {
  const settings = { ...DEFAULT_SETTINGS, enabled: true, backend: 'local', model: MODEL.id,
    localModelId: MODEL.id, sourceLanguage: 'auto', targetLanguage: 'ja', urgentSeconds: 120,
    localPerformance: { languageValidation: 'strict' } };
  const cache = new MemoryTranslationCache();
  const key = translationCacheKey(LIVE_PREVIEW_RESOURCE, '你好', settings);
  await cache.set(key, '你好', { resourceId: LIVE_PREVIEW_RESOURCE });
  let calls = 0;
  const engine = new TranslationEngine({ cache, maxAttempts: 1, validateResult: strictNativeResultIssue,
    provider: { async complete() { calls++; throw new ProviderError('network-error', true); } } });
  const result = await engine.translate({ resourceId: LIVE_PREVIEW_RESOURCE, settings,
    apiKey: 'local-test', items: [{ id: 'one', text: '你好', deadlineAt: performance.now() + 30_000 }] });
  assert.equal(calls, 1);
  assert.equal(result.items[0].status, 'failed');
  assert.equal(engine.stats().retries, 0);
  engine.dispose();
});
