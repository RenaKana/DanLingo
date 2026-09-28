import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../../src/core/config.ts';
import { resolveLocalConfig } from '../../src/local/config.ts';
import { ProviderError, setProviderTransportGuard } from '../../src/translation/provider.ts';
import { LivePreviewHost, LIVE_PREVIEW_RESOURCE, NATIVE_SUPPLY_BUDGET_KEY,
  OWNED_SUPPLY_GRANT_KEY, OWNED_SUPPLY_BUDGET_KEY, OWNED_SUPPLY_GUARD_KEY,
  OWNED_SUPPLY_HISTORY_KEY } from '../../src/diagnostics/live-preview-host.ts';

const clone = value => value === undefined ? undefined : structuredClone(value);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 2000);
    })]);
  } finally { clearTimeout(timer); }
}
const MODEL = { id: 'registered-hy-1-8b', name: 'Hy-MT2-1.8B-Q4', files: ['Hy-MT2-1.8B-Q4.gguf'],
  bytes: 1_800_000_000, architecture: 'hunyuan-dense', quantization: 'Q4', tokenizer: 'fixture',
  template: true, importedAt: 1, availability: 'ready', metadataVersion: 1, metadataComplete: true };
const SESSION = { platform: 'bilibili', scenario: 'video', resourceId: 'BV-fixture:cid-other',
  sessionId: 'owned-fixture', generation: 1 };
const demand = (epoch = 3, text = 'こんにちは') => ({ id: `d-${epoch}`, sourceId: `source-${epoch}`,
  originalText: text, mediaTimeMs: 125_000, deadlineAtEpochMs: Date.now() + 30_000,
  epoch, predictionEpoch: 7, ruleRevision: 1 });

function harness() {
  const values = new Map(), controls = [], bodies = [], pageMessages = [];
  const beforeSendFinished = deferred();
  let activeBeforeSend = 0, heldProof, heldStoppedGrantSave;
  let session = clone(SESSION), documentId = 'owned-document', buildId = 'owned-build',
    configVersion = 2, rate = 2, currentDemand = demand(), sends = 0, unloads = 0, loads = 0;
  let state = { phase: 'idle', generation: 0, inferenceCalls: 0, active: 0, queued: 0 };
  const settings = { ...DEFAULT_SETTINGS, enabled: false, bilibiliOwnedRelease: true, backend: 'local',
    localModelId: MODEL.id, model: MODEL.id, sourceLanguage: 'ja', targetLanguage: 'zh', localConcurrency: 3,
    localPerformance: { mode: 'custom', parallel: 3, normalMaxTokens: 192, promptMode: 'auto',
      languageValidation: 'off', warmup: true } };
  const storage = {
    async get(keys) { return Object.fromEntries((typeof keys === 'string' ? [keys] : keys)
      .map(key => [key, clone(values.get(key))])); },
    async set(record) {
      const grant = record[OWNED_SUPPLY_GRANT_KEY];
      if (heldStoppedGrantSave && grant?.state === 'stopped') {
        const gate = heldStoppedGrantSave;
        heldStoppedGrantSave = undefined;
        gate.entered.resolve();
        await gate.release.promise;
      }
      for (const [key, value] of Object.entries(record)) values.set(key, clone(value));
    },
    async remove(key) { values.delete(key); },
  };
  let host;
  const newHost = () => new LivePreviewHost({ purpose: 'owned-supply', buildId, storage,
    context: async tabId => tabId === 41 ? ({ settings: clone(settings), configVersion, tabId,
      documentId, session: clone(session), idle: true }) : null,
    localControl: async control => {
      controls.push(clone(control));
      if (control.action === 'list') return { ok: true, models: [clone(MODEL)], state: clone(state) };
      if (control.action === 'state') return { ok: true, state: clone(state) };
      if (control.action === 'load') {
        loads++;
        assert.equal(control.modelId, MODEL.id);
        assert.equal(control.config.warmup, false);
        assert.equal(control.config.mode, 'custom');
        assert.equal(control.config.parallel, 3);
        assert.equal(control.config.normalMaxTokens, 192);
        state = { ...state, phase: 'ready', model: clone(MODEL), generation: state.generation + 1,
          runtime: { ...resolveLocalConfig(control.config, MODEL.id), kvUnified: true,
            continuousBatching: true }, warmupMs: 0 };
        return { ok: true, state: clone(state) };
      }
      if (control.action === 'unload') {
        unloads++;
        state = { ...state, phase: 'idle', model: undefined, runtime: undefined,
          inferenceCalls: 0, generation: state.generation + 1 };
        return { ok: true, state: clone(state) };
      }
      throw new Error(`unexpected control ${control.action}`);
    },
    page: async (_tabId, _documentId, message) => {
      pageMessages.push(clone(message));
      if (message.type === 'bilibili-native-supply-proof') {
        if (heldProof && activeBeforeSend > 0 && ++heldProof.beforeSendProofs === 2) {
          heldProof.entered.resolve();
          await heldProof.release.promise;
        }
        return { ok: true, buildId,
        runId: message.runId, instanceId: message.instanceId, epoch: message.epoch,
        session: clone(session), contextValid: true, visible: true,
        clock: { mediaTimeMs: 121_000, paused: false, seeking: false, playbackRate: rate, contentActive: true },
        demands: [clone(currentDemand)] };
      }
      return { ok: true };
    },
    createLocalFetch: (_modelId, gate) => async (_url, init) => {
      const id = `attempt-${++sends}`;
      activeBeforeSend++;
      try {
        // Keep this test's final grant-state assertion independent of AbortSignal cancellation.
        await gate.beforeSend(id, heldProof ? { aborted: false } : init.signal);
        gate.sent?.(id);
        bodies.push(JSON.parse(init.body));
        state.inferenceCalls++;
        return new Response(JSON.stringify({ choices: [{ message: { content: '你好' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
      } finally {
        activeBeforeSend--;
        beforeSendFinished.resolve();
      }
    },
    globalIdle: async () => true,
  });
  host = newHost();
  setProviderTransportGuard(async context => {
    if (!await host.acceptsTransport(context)) throw new ProviderError('owned-test-guard-rejected');
  });
  const prepare = (overrides = {}) => host.prepare({ taskId: 'owned-task', runId: 'owned-run',
    phase: 'main', tabId: 41, epoch: 3, fromMs: 120_000, toMs: 1_200_000, ...overrides });
  const translate = (grant, item = currentDemand, requestId = `request-${item.id}`) =>
    host.translate(41, documentId, { runId: grant.runId, instanceId: grant.instanceId,
      epoch: item.epoch, requestId, items: [{ ...item, text: item.originalText }] });
  return { values, controls, bodies, pageMessages, prepare, translate,
    get host() { return host; }, get sends() { return sends; }, get loads() { return loads; },
    get unloads() { return unloads; },
    beforeSendFinished: beforeSendFinished.promise,
    blockSecondBeforeSendProof() {
      heldProof = { beforeSendProofs: 0, entered: deferred(), release: deferred() };
      return heldProof;
    },
    blockStoppedGrantSave() {
      heldStoppedGrantSave = { entered: deferred(), release: deferred() };
      return heldStoppedGrantSave;
    },
    keepItemsCurrentDuringAbort() {
      const complete = host.complete.bind(host);
      host.complete = (run, request) => complete(run, { ...request, isItemCurrent: () => true });
    },
    restart() { configVersion = 0; host = newHost(); },
    setSession(value) { session = clone(value); },
    setDocument(value) { documentId = value; },
    setDemand(value) { currentDemand = clone(value); },
    setRate(value) { rate = value; },
    setSettings(value) { Object.assign(settings, value); },
  };
}
afterEach(() => setProviderTransportGuard());

test('owned grant uses the selected 1.8B model, languages and performance on any video at 2x', async () => {
  const h = harness();
  h.values.set(NATIVE_SUPPLY_BUDGET_KEY, { legacy: 'untouched' });
  const prepared = await h.prepare();
  assert.equal(prepared.grant.policy, 'owned');
  assert.equal(prepared.grant.sourceLanguage, 'ja');
  assert.equal(prepared.grant.targetLanguage, 'zh');
  assert.equal(prepared.grant.session.resourceId, SESSION.resourceId);
  assert.notEqual(prepared.grant.session.resourceId, LIVE_PREVIEW_RESOURCE);
  assert.deepEqual([prepared.grant.fromMs, prepared.grant.toMs], [120_000, 1_200_000]);
  assert.equal(h.values.get(OWNED_SUPPLY_GUARD_KEY).kind, 'owned-supply');
  assert.equal(h.loads, 1);
  assert.equal(h.sends, 0);
  assert.deepEqual(prepared.budget.total.limits, { requests: 100, items: 100, utf16Chars: 2000 });
  assert.deepEqual(h.values.get(NATIVE_SUPPLY_BUDGET_KEY), { legacy: 'untouched' });
  await h.host.start(41, 'owned-document', 'owned-run', prepared.grant.instanceId);
  const result = await h.translate(prepared.grant);
  assert.equal(result.items[0].status, 'translated');
  assert.equal(result.items[0].text, '你好');
  assert.equal(result.items[0].nativeSupply.kind, 'new-inference');
  assert.equal(result.budgetExhausted, false);
  assert.equal(h.sends, 1);
  assert.equal(h.bodies[0].max_tokens, 192);
  assert.equal(h.pageMessages.at(-1).type, 'bilibili-native-supply-result');
  assert.equal((await h.host.status()).budget.total.actualSent.requests, 1);
});

test('invalid ranges, unselected model, release off and guard conflict reject before loading', async () => {
  for (const [range, reason] of [
    [{ fromMs: -1 }, /invalid-owned-window/], [{ toMs: 43_200_001 }, /invalid-owned-window/],
    [{ fromMs: 10, toMs: 10 }, /invalid-owned-window/],
    [{ modelId: 'some-other-model' }, /requires-selected-idle-local-model/],
  ]) {
    const h = harness();
    await assert.rejects(h.prepare(range), reason);
    assert.equal(h.loads, 0);
  }
  const off = harness(); off.setSettings({ bilibiliOwnedRelease: false });
  await assert.rejects(off.prepare(), /requires-selected-idle-local-model/);
  assert.equal(off.loads, 0);
  const guarded = harness();
  guarded.values.set('bilibiliRenderPreview.zeroTransport.v1', { enabled: true });
  await assert.rejects(guarded.prepare(), /existing-guard/);
  assert.equal(guarded.loads, 0);
});

test('owned proof allows finite 16x but rejects faster or paused playback before sending', async () => {
  const h = harness(); const prepared = await h.prepare();
  await h.host.start(41, 'owned-document', 'owned-run', prepared.grant.instanceId);
  h.setRate(16);
  assert.equal((await h.translate(prepared.grant)).items[0].status, 'translated');
  h.setRate(16.1); h.setDemand(demand(3, '別の言葉'));
  await assert.rejects(h.translate(prepared.grant, demand(3, '別の言葉'), 'another-request'), /no-current-demand/);
  assert.equal((await h.host.status()).budget.total.actualSent.requests, 1);
});

test('another task guard revokes owned transport and prevents unloading a shared model', async () => {
  const h = harness(); const prepared = await h.prepare();
  await h.host.start(41, 'owned-document', 'owned-run', prepared.grant.instanceId);
  h.values.set('bilibiliRenderPreview.zeroTransport.v1', { enabled: true });
  await assert.rejects(h.translate(prepared.grant), /other-guard-or-missing-owner/);
  assert.equal(h.sends, 0);
  await h.host.cleanup();
  assert.equal(h.unloads, 0);
  assert.equal(h.values.has(OWNED_SUPPLY_GUARD_KEY), false);
  assert.equal(h.values.has('bilibiliRenderPreview.zeroTransport.v1'), true);
});

test('stop and restart resume the same persisted ledger with a new epoch and no model call', async () => {
  const h = harness(); const prepared = await h.prepare();
  await h.host.start(41, 'owned-document', 'owned-run', prepared.grant.instanceId);
  await h.translate(prepared.grant);
  await h.host.stop('owned-resume');
  h.setSession({ ...SESSION, generation: 2 });
  h.restart();
  const resumed = await h.host.resume({ taskId: 'owned-task', runId: 'owned-run', tabId: 41,
    documentId: 'owned-document', instanceId: prepared.grant.instanceId, buildId: 'owned-build',
    epoch: 4, fromMs: 120_500, toMs: 1_200_000 });
  assert.equal(resumed.grant.state, 'prepared');
  assert.notEqual(resumed.grant.instanceId, prepared.grant.instanceId);
  assert.equal(resumed.grant.epoch, 4);
  assert.equal(resumed.grant.fromMs, 120_500);
  assert.equal(resumed.budget.total.actualSent.requests, 1);
  assert.equal(h.loads, 1);
  assert.equal(h.sends, 1);
  await h.host.start(41, 'owned-document', 'owned-run', resumed.grant.instanceId);
  assert.equal(h.sends, 1);
});

test('same-worker resume preserves qualified memory cache while rebinding playback identity', async () => {
  const h = harness(), prepared = await h.prepare();
  await h.host.start(41, 'owned-document', 'owned-run', prepared.grant.instanceId);
  assert.equal((await h.translate(prepared.grant)).items[0].status, 'translated');
  await h.host.stop('owned-resume');
  h.setSession({ ...SESSION, generation: 2 });
  const next = demand(4); h.setDemand(next);
  const resumed = await h.host.resume({ taskId: 'owned-task', tabId: 41, documentId: 'owned-document',
    runId: 'owned-run', instanceId: prepared.grant.instanceId, epoch: 4, buildId: 'owned-build',
    fromMs: 120000, toMs: 1200000 });
  await h.host.start(41, 'owned-document', 'owned-run', resumed.grant.instanceId);
  const output = await h.translate(resumed.grant, next, 'resumed-request');
  assert.equal(output.items[0].status, 'cached');
  assert.equal(h.sends, 1);
  assert.equal((await h.host.status()).budget.total.actualSent.requests, 1);
});

test('retiring an owned run waits for its in-flight send and keeps its budget without transport', async () => {
  const h = harness();
  const proof = h.blockSecondBeforeSendProof();
  h.keepItemsCurrentDuringAbort();
  let translation, retirement;
  try {
    const prepared = await within(h.prepare(), 'retire prepare');
    await within(h.host.start(41, 'owned-document', 'owned-run', prepared.grant.instanceId), 'retire start');
    translation = h.translate(prepared.grant);
    await within(proof.entered.promise, 'retire beforeSend proof');
    retirement = h.host.retireOwned(prepared.grant);
    proof.release.resolve();
    await within(translation, 'retired translation');
    await within(retirement, 'retirement cleanup');
    assert.equal(h.bodies.length, 0);
    assert.equal(h.values.has(OWNED_SUPPLY_GUARD_KEY), false);
    assert.equal(h.values.get(OWNED_SUPPLY_GRANT_KEY).reason, 'cleanup');
    assert.equal((await h.host.status()).budget.total.actualSent.requests, 0);
  } finally {
    proof.release.resolve();
    await Promise.allSettled([translation, retirement].filter(Boolean));
  }
});

test('retire requires exact task, run, instance and owned guard; it never clears another guard', async () => {
  const empty = harness();
  await empty.host.retireOwned({ taskId: 'absent', runId: 'absent', instanceId: 'absent',
    tabId: 41, documentId: 'owned-document' });
  const h = harness();
  const prepared = await h.prepare();
  await h.host.start(41, 'owned-document', 'owned-run', prepared.grant.instanceId);
  for (const mismatch of [
    { taskId: 'another-task' }, { runId: 'another-run' }, { instanceId: 'another-instance' },
    { tabId: 42 }, { documentId: 'another-document' },
  ]) {
    await assert.rejects(h.host.retireOwned({ ...prepared.grant, ...mismatch }), /retired-owner-changed/);
    assert.equal(h.values.get(OWNED_SUPPLY_GRANT_KEY).state, 'running');
  }
  const ownedGuard = structuredClone(h.values.get(OWNED_SUPPLY_GUARD_KEY));
  h.values.set(OWNED_SUPPLY_GUARD_KEY, { ...ownedGuard, runId: 'another-run' });
  await assert.rejects(h.host.retireOwned(prepared.grant), /retired-owner-changed/);
  h.values.set(OWNED_SUPPLY_GUARD_KEY, ownedGuard);
  h.values.set('bilibiliRenderPreview.zeroTransport.v1', { enabled: true, kind: 'another-task' });
  await h.host.retireOwned(prepared.grant);
  assert.equal(h.values.has(OWNED_SUPPLY_GUARD_KEY), false);
  assert.deepEqual(h.values.get('bilibiliRenderPreview.zeroTransport.v1'),
    { enabled: true, kind: 'another-task' });
  assert.equal(h.unloads, 0);
});

test('cleanup keeps the ledger, explicit new budget archives it, and legacy budgets remain untouched', async () => {
  const h = harness(); h.values.set(NATIVE_SUPPLY_BUDGET_KEY, { legacy: 'untouched' });
  const prepared = await h.prepare();
  await h.host.start(41, 'owned-document', 'owned-run', prepared.grant.instanceId);
  await h.translate(prepared.grant);
  await h.host.cleanup();
  assert.equal(h.unloads, 1);
  assert.equal(h.values.has(OWNED_SUPPLY_GUARD_KEY), false);
  await assert.rejects(h.prepare({ taskId: 'new-task', runId: 'new-run' }), /owned-resume-or-budget-required/);
  assert.equal(h.values.get(OWNED_SUPPLY_BUDGET_KEY).attempts.length, 1);
  h.setSession({ ...SESSION, generation: 2 }); h.setDocument('second-document');
  const sameLedger = await h.prepare({ epoch: 4, fromMs: 121_000 });
  assert.equal(sameLedger.budget.total.actualSent.requests, 1);
  await h.host.cleanup();
  const next = await h.prepare({ taskId: 'new-task', runId: 'new-run', epoch: 5,
    authorizedNewBudget: true });
  assert.equal(next.budget.total.actualSent.requests, 0);
  assert.equal(h.values.get(OWNED_SUPPLY_HISTORY_KEY).length, 1);
  assert.equal(h.values.get(OWNED_SUPPLY_HISTORY_KEY)[0].budget.attempts.length, 1);
  assert.equal(h.values.get(OWNED_SUPPLY_HISTORY_KEY)[0].grant.taskId, 'owned-task');
  assert.deepEqual(h.values.get(NATIVE_SUPPLY_BUDGET_KEY), { legacy: 'untouched' });
  assert.equal(h.values.get(OWNED_SUPPLY_GRANT_KEY).taskId, 'new-task');
});

test('one oversized UTF-16 demand is denied before transport and reported to the page', async () => {
  const h = harness(); const prepared = await h.prepare();
  await h.host.start(41, 'owned-document', 'owned-run', prepared.grant.instanceId);
  const oversized = demand(3, 'あ'.repeat(2001));
  h.setDemand(oversized);
  const result = await h.translate(prepared.grant, oversized);
  assert.equal(result.budgetExhausted, true);
  assert.equal(result.budgetReason, 'insufficient-for-request');
  assert.equal(result.budgetRemaining.utf16Chars, 2000);
  assert.equal((await h.host.status()).budget.total.actualSent.requests, 0);
  assert.equal(h.bodies.length, 0);
});

test('stop revokes an owned send while its final proof and grant save are blocked', async () => {
  const h = harness();
  const proof = h.blockSecondBeforeSendProof();
  const stoppedGrantSave = h.blockStoppedGrantSave();
  h.keepItemsCurrentDuringAbort();
  let translation, stopping;
  try {
    const prepared = await within(h.prepare(), 'owned prepare');
    await within(h.host.start(41, 'owned-document', 'owned-run', prepared.grant.instanceId), 'owned start');
    translation = h.translate(prepared.grant);
    await within(proof.entered.promise, 'second proof inside beforeSend');

    stopping = h.host.stop('stop-during-final-proof');
    await within(stoppedGrantSave.entered.promise, 'stopped grant storage.set');
    assert.equal(h.values.get(OWNED_SUPPLY_GRANT_KEY).state, 'running');

    proof.release.resolve();
    await within(h.beforeSendFinished, 'beforeSend completion');
    await within(translation, 'translation completion');
    const status = await within(h.host.status(), 'host status');
    assert.equal(h.bodies.length, 0);
    assert.equal(status.budget.total.actualSent.requests, 0);
    assert.equal(status.grant.state, 'stopped');
  } finally {
    proof.release.resolve();
    stoppedGrantSave.release.resolve();
    await Promise.allSettled([
      translation && within(translation, 'translation cleanup'),
      stopping && within(stopping, 'stop cleanup'),
    ].filter(Boolean));
  }
});
