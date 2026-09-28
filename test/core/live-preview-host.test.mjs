import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../../src/core/config.ts';
import { normalizeLocalConfig } from '../../src/local/config.ts';
import { setProviderTransportGuard, ProviderError } from '../../src/translation/provider.ts';
import {
  LIVE_PREVIEW_BUDGET_KEY, LIVE_PREVIEW_GRANT_KEY, LIVE_PREVIEW_RESOURCE, LivePreviewHost,
} from '../../src/diagnostics/live-preview-host.ts';

const BUILD_ID = 'host-fixture-build';
const TASK_ID = 'task-fixture';
const RUN_ID = 'run-fixture';
const TAB_ID = 41;
const DOCUMENT_ID = 'document-fixture';
const SESSION = {
  platform: 'bilibili', scenario: 'video', resourceId: LIVE_PREVIEW_RESOURCE,
  sessionId: 'session-fixture', generation: 7,
};
const MODEL = {
  id: 'fixture-model', name: 'Fixture local model', files: ['fixture.gguf'], bytes: 1024,
  architecture: 'llama', quantization: 'Q4_K_M', tokenizer: 'fixture-tokenizer', template: true,
  importedAt: 1, availability: 'ready', metadataVersion: 1, metadataComplete: true,
};
const runtime = {
  ...normalizeLocalConfig({ warmup: false, promptMode: 'json' }), contextTokens: 4096,
  kvUnified: true, continuousBatching: true,
};

const clone = value => value === undefined ? undefined : structuredClone(value);
function localState(phase, generation, model = undefined) {
  return {
    phase, backend: 'wllama fixture', ...(model ? { model: clone(model) } : {}),
    generation, queued: 0, loadMs: undefined, inferenceCalls: 0, contextTokens: 4096,
    verifiedTranslation: false, active: 0, completed: 0, failed: 0, cancelled: 0, peakActive: 0,
    ...(phase === 'ready' ? { runtime: clone(runtime), warmupMs: 0 } : {}),
  };
}

function harness({ initialPhase = 'idle', model = MODEL, models = [model], loadPlan = [],
  outputText = 'こんにちは', configVersion = 12, contextAvailable = true } = {}) {
  const values = new Map();
  let state = localState(initialPhase, initialPhase === 'idle' ? 0 : 5, initialPhase === 'ready' ? model : undefined);
  let settings = { ...DEFAULT_SETTINGS, enabled: false, backend: 'local', model: model.id,
    localModelId: model.id, localPerformance: { promptMode: 'json', languageValidation: 'strict' } };
  let currentConfigVersion = configVersion;
  let currentModelRows = clone(models);
  let currentContextAvailable = contextAvailable;
  let plan = [...loadPlan];
  let fetchInvocations = 0, sentRequests = 0, loadRequests = 0, unloadRequests = 0, pageProofs = 0;
  const controls = [];
  const pageMessages = [];
  let deferredProof;
  const storage = {
    async get(keys) {
      const list = typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(list.map(key => [key, clone(values.get(key))]));
    },
    async set(row) { for (const [key, value] of Object.entries(row)) values.set(key, clone(value)); },
    async remove(key) { values.delete(key); },
  };
  const localControl = async control => {
    controls.push(clone(control));
    if (control.action === 'list') return { ok: true, models: clone(currentModelRows), state: clone(state) };
    if (control.action === 'state') return { ok: true, state: clone(state) };
    if (control.action === 'load') {
      loadRequests += 1;
      const grant = values.get(LIVE_PREVIEW_GRANT_KEY);
      controls.at(-1).persistedLoadState = clone(grant && {
        modelLoads: grant.modelLoads, loadRecoveryCount: grant.loadRecoveryCount, loadOwnership: grant.loadOwnership,
      });
      const failure = plan.shift();
      if (failure) {
        state = localState('error', state.generation + 1, { id: control.modelId });
        state.error = failure;
        return { ok: false, error: failure, state: clone(state) };
      }
      state = localState('ready', state.generation + 1, clone(currentModelRows.find(item => item.id === control.modelId)));
      return { ok: true, state: clone(state) };
    }
    if (control.action === 'unload') {
      unloadRequests += 1;
      state = localState('idle', state.generation + 1);
      return { ok: true, state: clone(state) };
    }
    throw new Error(`unexpected local action: ${control.action}`);
  };
  const options = {
    buildId: BUILD_ID, storage,
    context: async tabId => currentContextAvailable && tabId === TAB_ID ? {
      settings: clone(settings), configVersion: currentConfigVersion, tabId, documentId: DOCUMENT_ID,
      session: clone(SESSION), idle: true,
    } : null,
    localControl,
    page: async (_tabId, _documentId, message) => {
      pageMessages.push(clone(message));
      if (message.type === 'bilibili-live-preview-proof') {
        pageProofs += 1;
        if (deferredProof) return deferredProof.promise;
        return {
          ok: true, buildId: BUILD_ID, runId: message.runId, instanceId: message.instanceId, epoch: message.epoch,
          session: clone(SESSION), contextValid: true, visible: true,
          clock: { mediaTimeMs: 50_000, paused: false, seeking: false, playbackRate: 1, contentActive: true },
          demands: [
            { id: 'demand-a', sourceId: 'source-a', originalText: '你好', mediaTimeMs: 65_000 },
            { id: 'demand-b', sourceId: 'source-b', originalText: '你好', mediaTimeMs: 66_000 },
          ],
        };
      }
      return { ok: true };
    },
    createLocalFetch: (_modelId, gate) => async (_url, init = {}) => {
      fetchInvocations += 1;
      const attemptId = `attempt-${fetchInvocations}`;
      await gate.beforeSend(attemptId, init.signal);
      if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      gate.sent?.(attemptId);
      sentRequests += 1;
      state.inferenceCalls += 1; // Synthetic fixture evidence only; no model or browser is used.
      const request = JSON.parse(String(init.body));
      const envelope = JSON.parse(request.messages.at(-1).content);
      const rows = envelope.items.map(item => ({ id: item.id, text: outputText }));
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ items: rows }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    globalIdle: async () => true,
  };
  let host = new LivePreviewHost(options);
  const grantValue = async () => (await storage.get(LIVE_PREVIEW_GRANT_KEY))[LIVE_PREVIEW_GRANT_KEY];
  const prepare = async (overrides = {}) => host.prepare({ taskId: TASK_ID, runId: RUN_ID,
    phase: 'main', tabId: TAB_ID, epoch: 3, ...overrides });
  const start = async grant => host.start(TAB_ID, DOCUMENT_ID, RUN_ID, grant.instanceId);
  const translate = (grant, items = [{ id: 'source-a', text: '你好', remainingMs: 30_000 }], requestId = 'request-a') =>
    host.translate(TAB_ID, DOCUMENT_ID, { runId: RUN_ID, instanceId: grant.instanceId, epoch: 3, requestId, items });
  const deferNextProof = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    deferredProof = { promise, resolve };
    return deferredProof;
  };
  return {
    options, storage, controls, pageMessages, localControl, prepare, start, translate, grantValue, deferNextProof,
    setContextAvailable(value) { currentContextAvailable = value; },
    setConfigVersion(value) { currentConfigVersion = value; },
    setSettings(value) { settings = clone(value); },
    setModels(value) { currentModelRows = clone(value); },
    setState(value) { state = clone(value); },
    setHost(value) { host = value; },
    newHost() { return new LivePreviewHost(options); },
    get host() { return host; },
    get state() { return clone(state); },
    get fetchInvocations() { return fetchInvocations; },
    get sentRequests() { return sentRequests; },
    get loadRequests() { return loadRequests; },
    get unloadRequests() { return unloadRequests; },
    get pageProofs() { return pageProofs; },
    get pageMessages() { return clone(pageMessages); },
    get loadSnapshots() { return controls.filter(row => row.action === 'load').map(row => row.persistedLoadState); },
    makeProof(message) {
      return {
        ok: true, buildId: BUILD_ID, runId: message.runId, instanceId: message.instanceId, epoch: message.epoch,
        session: clone(SESSION), contextValid: true, visible: true,
        clock: { mediaTimeMs: 50_000, paused: false, seeking: false, playbackRate: 1, contentActive: true },
        demands: [
          { id: 'demand-a', sourceId: 'source-a', originalText: '你好', mediaTimeMs: 65_000 },
          { id: 'demand-b', sourceId: 'source-b', originalText: '你好', mediaTimeMs: 66_000 },
        ],
      };
    },
  };
}

function installGuard(host) {
  setProviderTransportGuard(async context => {
    if (!await host.acceptsTransport(context)) throw new ProviderError('live-preview-test-guard-rejected');
  });
}

async function prepareAndStart(h) {
  const prepared = await h.prepare();
  await h.start(prepared.grant);
  return prepared.grant;
}

afterEach(() => setProviderTransportGuard(undefined));

test('preflight requires listed, complete model metadata and loads once without warmup', async () => {
  const h = harness();
  const prepared = await h.prepare();
  assert.equal(h.loadRequests, 1);
  assert.equal(h.controls.some(row => row.action === 'list'), true);
  assert.equal(h.controls.find(row => row.action === 'load').config.warmup, false);
  assert.equal(prepared.grant.loadOwnership, 'owned');
  assert.equal(prepared.grant.modelName, MODEL.name);
  assert.equal(prepared.grant.modelIdentityKind, 'metadata-only-sha256');
  assert.equal(prepared.grant.modelBaseline.phase, 'idle');
  assert.equal(prepared.grant.modelAfterLoad.modelName, MODEL.name);
  assert.equal(prepared.grant.modelAfterLoad.inferenceCalls, 0);
  assert.equal((await h.host.status(false, true)).localState.modelName, MODEL.name);
  assert.equal(h.state.inferenceCalls, 0);
});

test('repair ranges stay inside the main preview interval', async () => {
  for (const [fromMs, toMs] of [[44999, 50000], [65000, 85001]]) {
    const h = harness();
    await assert.rejects(h.prepare({ phase: 'repair', fromMs, toMs, repairReason: 'bounded repair' }),
      /live-preview-invalid-repair/);
    assert.equal(h.loadRequests, 0, 'an out-of-range repair must fail before loading the model');
    assert.equal((await h.storage.get('bilibiliRenderPreview.zeroTransport.v1'))['bilibiliRenderPreview.zeroTransport.v1'], undefined,
      'an out-of-range repair must not grant the transport guard');
  }
});

test('supplement requires a reason and the fixed full interval before model load', async () => {
  for (const overrides of [
    { repairReason: ' ' },
    { repairReason: 'explicit extra pass', fromMs: 45001, toMs: 85000 },
    { repairReason: 'explicit extra pass', fromMs: 45000, toMs: 84999 },
  ]) {
    const h = harness();
    await assert.rejects(h.prepare({ phase: 'supplement', runId: 'supplement-run', ...overrides }), /live-preview-invalid-supplement/);
    assert.equal(h.loadRequests, 0);
    assert.equal((await h.storage.get(LIVE_PREVIEW_GRANT_KEY))[LIVE_PREVIEW_GRANT_KEY], undefined);
  }
});

test('supplement reuses the old task ledger and selected local model configuration', async () => {
  const h = harness();
  const main = await h.prepare({ runId: 'main-run' });
  await h.host.cleanup();
  const repair = await h.prepare({ phase: 'repair', runId: 'repair-run', repairReason: 'first repair' });
  await h.host.cleanup();
  const legacy = (await h.storage.get(LIVE_PREVIEW_BUDGET_KEY))[LIVE_PREVIEW_BUDGET_KEY];
  delete legacy.phaseRuns.supplement;
  await h.storage.set({ [LIVE_PREVIEW_BUDGET_KEY]: legacy });

  const input = { phase: 'supplement', runId: 'supplement-run', repairReason: 'explicit extra full pass',
    fromMs: 45000, toMs: 85000 };
  const prepared = await h.prepare(input);
  assert.equal(prepared.grant.taskId, TASK_ID);
  assert.equal(prepared.grant.phase, 'supplement');
  assert.equal(prepared.grant.repairReason, input.repairReason);
  assert.deepEqual([prepared.grant.fromMs, prepared.grant.toMs], [45000, 85000]);
  assert.equal(prepared.grant.modelId, main.grant.modelId);
  assert.equal(prepared.grant.modelIdentity, main.grant.modelIdentity);
  assert.equal(prepared.grant.configIdentity, main.grant.configIdentity);
  assert.equal(prepared.grant.configIdentity, repair.grant.configIdentity);
  assert.deepEqual((await h.grantValue()).repairReason, input.repairReason);
  assert.equal(prepared.budget.phases.supplement.runId, input.runId);
  assert.equal(prepared.budget.total.occupied.requests, 0);
  assert.equal(h.sentRequests, 0);
  const repeated = await h.prepare(input);
  assert.equal(repeated.grant.instanceId, prepared.grant.instanceId);
  await assert.rejects(h.prepare({ ...input, repairReason: 'changed reason' }), /live-preview-identity-mismatch/);
  await h.host.cleanup();
});

test('an explicit page start is persisted once without sending any demand', async () => {
  const h = harness();
  const prepared = await h.prepare();
  assert.equal(prepared.grant.startedAt, undefined);
  const started = await h.start(prepared.grant);
  assert.ok(Number.isFinite(started.grant.startedAt) && started.grant.startedAt > 0);
  assert.equal((await h.grantValue()).startedAt, started.grant.startedAt);
  await h.start(prepared.grant);
  await h.host.stop('manual-page-stop');
  assert.equal((await h.grantValue()).startedAt, started.grant.startedAt);
  assert.equal(h.sentRequests, 0);
});

test('missing or incomplete listed metadata rejects before load or granting the guard', async () => {
  const missing = harness({ models: [] });
  await assert.rejects(missing.prepare(), /selected-model-missing/);
  assert.equal(missing.loadRequests, 0);

  const incomplete = harness({ models: [{ ...MODEL, metadataComplete: false }] });
  await assert.rejects(incomplete.prepare(), /model-metadata-unavailable/);
  assert.equal(incomplete.loadRequests, 0);
  assert.equal((await incomplete.storage.get(LIVE_PREVIEW_GRANT_KEY))[LIVE_PREVIEW_GRANT_KEY], undefined);
});

test('only one persisted retry follows an allowlisted environment load failure', async () => {
  const h = harness({ loadPlan: ['LOCAL_WORKER_FAILED'] });
  const prepared = await h.prepare();
  assert.equal(h.loadRequests, 2);
  assert.deepEqual(h.loadSnapshots.map(row => [row.modelLoads, row.loadRecoveryCount, row.loadOwnership]), [
    [1, 0, 'loading'], [2, 1, 'loading'],
  ]);
  assert.equal(prepared.grant.loadRecoveryCount, 1);
  assert.equal(prepared.grant.modelLoads, 2);
  assert.equal(prepared.grant.loadOwnership, 'owned');
  assert.equal(h.state.inferenceCalls, 0);
});

test('a different guard revokes requests before a local transport can send', async () => {
  const h = harness();
  const grant = await prepareAndStart(h);
  installGuard(h.host);
  await h.storage.set({ 'bilibiliRenderPreview.zeroTransport.v1': {
    enabled: true, kind: 'live-preview', tabId: TAB_ID, runId: 'another-run',
  } });
  await assert.rejects(h.translate(grant), /other-guard-or-missing-owner/);
  assert.equal(h.sentRequests, 0);
  assert.equal(h.host.ownerTabId, TAB_ID);
});

test('stop during asynchronous demand proof invalidates the request before sending', async () => {
  const h = harness();
  const grant = await prepareAndStart(h);
  const deferred = h.deferNextProof();
  const pending = h.translate(grant);
  while (h.pageProofs === 0) await new Promise(resolve => setTimeout(resolve, 0));
  await h.host.stop('test-stop');
  deferred.resolve(h.makeProof({ runId: RUN_ID, instanceId: grant.instanceId, epoch: 3 }));
  await assert.rejects(pending, /permit-revoked|not-running/);
  assert.equal(h.fetchInvocations, 0);
  assert.equal((await h.grantValue()).state, 'stopped');
});

test('demand invalidated after durable reservation is never sent', async () => {
  const h = harness();
  const grant = await prepareAndStart(h);
  installGuard(h.host);
  const page = h.options.page;
  let rejectedFinalProof = false;
  h.options.page = async (...args) => {
    const reply = await page(...args);
    if (args[2].type === 'bilibili-live-preview-proof') {
      const budget = (await h.storage.get(LIVE_PREVIEW_BUDGET_KEY))[LIVE_PREVIEW_BUDGET_KEY];
      if (budget.attempts.some(row => row.status === 'reserved')) {
        rejectedFinalProof = true;
        return { ...reply, clock: { ...reply.clock, paused: true } };
      }
    }
    return reply;
  };
  const response = await h.translate(grant);
  assert.equal(rejectedFinalProof, true);
  assert.equal(response.items[0].status, 'failed');
  assert.equal(h.sentRequests, 0);
  const status = await h.host.status();
  assert.equal(status.budget.total.actualSent.requests, 0);
  assert.equal(status.budget.attempts[0].status, 'not-sent');
  assert.equal(status.results.length, 0);
});

test('shared demand uses one validated engine result and records proof media time', async () => {
  const h = harness();
  const grant = await prepareAndStart(h);
  installGuard(h.host);
  const response = await h.translate(grant, [
    { id: 'source-a', text: '你好', remainingMs: 30_000 },
    { id: 'source-b', text: '你好', remainingMs: 30_000 },
  ]);
  assert.equal(h.sentRequests, 1);
  assert.equal(response.items.length, 2);
  assert.equal(response.items.every(item => item.status === 'translated' && item.text === 'こんにちは'), true);
  assert.equal(response.items.some(item => item.preview?.kind === 'new-inference'), true);
  assert.equal(response.items.some(item => item.preview?.kind === 'session-shared'), true);
  const status = await h.host.status(true, true);
  assert.equal(status.results.length, 1);
  assert.equal(status.results[0].text, 'こんにちは');
  assert.equal(status.results[0].validated, true);
  assert.equal(status.results[0].configIdentity, grant.configIdentity);
  assert.equal(status.inputs[0].items[0].owners[0].proofMediaTimeMs, 50_000);
  assert.equal(status.localState.phase, 'ready');
  assert.equal(status.localState.inferenceCalls, 1);
  assert.equal(status.budget.total.actualSent.requests, 1);
  assert.equal(h.state.inferenceCalls, 1, 'only the fake local fetch was invoked');
  const cached = await h.translate(grant, [{ id: 'source-b', text: '你好', remainingMs: 30_000 }], 'request-b');
  assert.equal(cached.items[0].status, 'cached');
  assert.equal(cached.items[0].preview?.kind, 'session-cache');
  assert.equal(cached.items[0].preview?.resultId, status.results[0].resultId);
  assert.equal(h.sentRequests, 1);
});

test('unchanged new output and its session-cache reuse fall back without preview readiness', async () => {
  const h = harness({ outputText: '你好' });
  const grant = await prepareAndStart(h);
  installGuard(h.host);
  const first = await h.translate(grant);
  assert.deepEqual(first.items.map(({ id, text, status, reason, preview }) =>
    ({ id, text, status, reason, preview })),
  [{ id: 'source-a', text: '你好', status: 'original', reason: 'unchanged-output', preview: undefined }]);
  assert.equal(h.sentRequests, 1);

  const second = await h.translate(grant, [{ id: 'source-b', text: '你好', remainingMs: 30_000 }], 'request-b');
  assert.equal(second.items[0].status, 'original');
  assert.equal(second.items[0].text, '你好');
  assert.equal(second.items[0].reason, 'unchanged-output');
  assert.equal(second.items[0].preview, undefined);
  assert.equal(h.sentRequests, 1, 'the repeated input is served from the session cache');

  const status = await h.host.status(true);
  assert.equal(status.engine.cacheHits, 1);
  assert.equal(status.results.length, 1);
  assert.equal(status.results[0].originalText, '你好');
  assert.equal(status.results[0].text, '你好');
  assert.equal(status.results[0].validated, false);
  assert.equal(status.results[0].reason, 'unchanged-output');
  assert.equal(status.results[0].usage.totalTokens, 12);
  assert.equal(status.results[0].deliveries, 0);
  assert.equal(status.budget.total.actualSent.requests, 1);
  assert.equal(status.budget.total.actualSent.items, 1);
  assert.equal(status.budget.usage.totals.totalTokens, 12);
  assert.equal(status.inputs.length, 1);
  assert.equal(status.deliveries.length, 2);
  assert.equal(status.deliveries.every(row => row.output.status === 'original' &&
    row.output.reason === 'unchanged-output' && !row.output.preview), true);
  assert.equal(h.pageMessages.filter(row => row.type === 'bilibili-live-preview-result').every(row =>
    row.output.status === 'original' && !row.output.preview), true);
});

test('provider text rejected by the engine quality gate never becomes a preview result', async () => {
  const h = harness({ outputText: 'This is a long English sentence with many words.' });
  const grant = await prepareAndStart(h);
  installGuard(h.host);
  const response = await h.translate(grant);
  assert.equal(response.items[0].status, 'failed');
  assert.equal(response.items[0].preview, undefined);
  assert.equal((await h.host.status()).results.length, 0);
  assert.equal(h.sentRequests, 1);
});

test('resume rotates the capability, tolerates a reset config counter, and preserves budget without auto-start', async () => {
  const h = harness();
  const grant = await prepareAndStart(h);
  installGuard(h.host);
  await h.translate(grant);
  const before = await h.host.status();
  assert.equal(before.budget.total.actualSent.requests, 1);

  const restarted = h.newHost();
  h.setHost(restarted);
  h.setConfigVersion(0); // A service-worker restart resets this memory-only counter.
  const resumed = await restarted.resume({ taskId: TASK_ID, tabId: TAB_ID, documentId: DOCUMENT_ID,
    runId: RUN_ID, instanceId: grant.instanceId, epoch: 3, buildId: BUILD_ID });
  assert.notEqual(resumed.grant.instanceId, grant.instanceId);
  assert.equal(resumed.grant.configVersion, 0);
  assert.equal(resumed.grant.state, 'prepared');
  assert.equal(resumed.budget.total.actualSent.requests, 1);
  assert.equal(h.loadRequests, 1);
  assert.equal(h.sentRequests, 1, 'resume itself does not issue a model request');
  assert.equal(resumed.activeRequests, 0);
  await assert.rejects(restarted.start(TAB_ID, DOCUMENT_ID, RUN_ID, grant.instanceId), /identity-mismatch/);
  await restarted.start(TAB_ID, DOCUMENT_ID, RUN_ID, resumed.grant.instanceId);
  assert.equal((await restarted.status()).grant.state, 'running');
  assert.equal(h.sentRequests, 1, 'start after resume also does not create a new demand');
});

test('a restarted host revokes its persisted tab owner and cleanup is bounded, owned, and repeatable', async () => {
  const h = harness();
  await prepareAndStart(h);
  const restarted = h.newHost();
  h.setHost(restarted);
  await restarted.stopForTab(TAB_ID);
  assert.equal((await h.grantValue()).state, 'stopped');
  assert.equal(restarted.ownerTabId, TAB_ID);

  h.setContextAvailable(false);
  const cleaned = await restarted.cleanup();
  assert.equal(h.unloadRequests, 1, 'only the generation loaded by this grant is unloaded after global-idle proof');
  assert.equal((await h.storage.get('bilibiliRenderPreview.zeroTransport.v1'))['bilibiliRenderPreview.zeroTransport.v1'], undefined);
  assert.equal(cleaned.localState.phase, 'idle');
  await restarted.cleanup();
  assert.equal(h.unloadRequests, 1);
});

test('cleanup leaves a preexisting selected model loaded', async () => {
  const h = harness({ initialPhase: 'ready' });
  const prepared = await h.prepare();
  assert.equal(prepared.grant.loadOwnership, 'preexisting');
  assert.equal(prepared.grant.loadedByTask, false);
  await h.host.cleanup();
  assert.equal(h.unloadRequests, 0);
  assert.equal(h.state.phase, 'ready');
});
