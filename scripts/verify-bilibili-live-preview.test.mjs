import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBilibiliLivePreview } from './bilibili-live-preview-analysis.mjs';
import { recoverLivePreviewWithoutNewCalls } from '../entrypoints/dispatch-runner/live-preview-recovery.ts';
import { assertLivePreviewPage, cleanupLivePreview, resumeLivePreview, runLivePreview, LIVE_PREVIEW_SAMPLE_INTERVAL_MS,
  LIVE_PREVIEW_RESOURCE, parseArgs, assertNextLivePreviewPhase, projectLivePreviewReceipt, settingsHash } from './verify-bilibili-live-preview.mjs';

const keyOf = row => JSON.stringify([row.resourceId, row.epoch, row.id]);
const event = (id, mediaTimeMs) => ({ id, sourceId: `source-${id}`, resourceId: LIVE_PREVIEW_RESOURCE,
  epoch: 1, mediaTimeMs, originalText: `原文${id}`, needsTranslation: true, state: 'committed' });

test('repair CLI stays within the authorized event window and twenty seconds', () => {
  const args = (start, end) => ['prepare', '--phase', 'repair', '--reason', 'verified bridge fix',
    '--from-ms', String(start), '--to-ms', String(end)];
  assert.deepEqual(parseArgs(args(45_000, 65_000)), { command: 'prepare', phase: 'repair',
    repairReason: 'verified bridge fix', fromMs: 45_000, toMs: 65_000 });
  assert.equal(parseArgs(args(65_000, 85_000)).toMs, 85_000);
  for (const [start, end] of [[44_999, 64_999], [65_001, 85_001], [45_000, 65_001],
    [85_000, 85_001]]) assert.throws(() => parseArgs(args(start, end)));
});

test('explicit supplement keeps the full fixed interval and spends its single slot after the cleaned repair', () => {
  const args = parseArgs(['prepare', '--phase', 'supplement', '--reason', 'User authorized one extra full run']);
  assert.deepEqual(args, { command: 'prepare', phase: 'supplement',
    repairReason: 'User authorized one extra full run', fromMs: 45_000, toMs: 85_000 });
  const prior = { phase: 'cleaned', phaseName: 'repair', repairUsed: true,
    runIssued: true, analysisPath: 'retained-analysis.json', cleanupConfirmed: true };
  assert.doesNotThrow(() => assertNextLivePreviewPhase(prior, args));
  for (const invalid of [null, { ...prior, phase: 'sampling' }, { ...prior, cleanupConfirmed: false },
    { ...prior, phaseName: 'main' }, { ...prior, supplementUsed: true }, { ...prior, analysisPath: null }])
    assert.throws(() => assertNextLivePreviewPhase(invalid, args));
  assert.throws(() => assertNextLivePreviewPhase({ ...prior, phaseName: 'supplement', supplementUsed: true }, args));
  assert.throws(() => assertNextLivePreviewPhase(prior, { phase: 'main' }));
  assert.throws(() => assertNextLivePreviewPhase(prior, { phase: 'repair' }));
  for (const extra of [[], ['--reason', ''], ['--reason', 'allowed', '--to-ms', '103000']])
    assert.throws(() => parseArgs(['prepare', '--phase', 'supplement', ...extra]));
});

function fixture() {
  const one = event('one', 52_000), two = event('two', 54_000), runId = 'run-1',
    configIdentity = 'config-1', instanceId = 'instance-1';
  const result = row => ({ taskId: `task-${row.id}`, resultId: `${runId}:task-${row.id}`,
    configIdentity, originalText: row.originalText, text: `翻訳${row.id}`, validated: true });
  const results = [result(one), result(two)];
  const ready = { ...one, key: keyOf(one), requestId: 'req-1', runId, instanceId, configIdentity,
    taskId: results[0].taskId, resultId: results[0].resultId, translatedText: results[0].text,
    status: 'translated', kind: 'new-inference', previewReadyAtMs: 100 };
  const page = { ok: true, version: '0.4.19', buildId: 'build-1', epoch: 1,
    session: { resourceId: LIVE_PREVIEW_RESOURCE, platform: 'bilibili', scenario: 'video', sessionId: 'session-1' },
    tailCutoff: { state: 'stopped' },
    report: { coverage: { mainBuildId: 'build-1' }, runId, instanceId,
      nativePrepared: 0, adapterPrepared: 0, nativeSettingsWrites: 0,
      plan: { B: { events: [one, two], previewReadyLog: [ready], outcomes: [], supplyStopped: true,
        parameters: { limit: 2 } } },
      render: { contract: 'render-preview-v1', records: [{ key: keyOf(one), sourceMode: 'stored-translation',
        origin: 'live-local', runId, configIdentity, resultId: results[0].resultId,
        chosenText: results[0].text, previewReadyAtMediaMs: 51_000, previewReadyAtWallMs: 100,
        textLockedAtWallMs: 120, renderSubmittedAtWallMs: 120, state: 'committed' },
      { key: keyOf(two), sourceMode: 'original', state: 'rejected', reason: 'late-result',
        textLockedAtWallMs: 130 }],
      ui: { domSamples: [{ key: keyOf(one), sourceMode: 'stored-translation', origin: 'live-local',
        runId, configIdentity, resultId: results[0].resultId }] } } } };
  const host = { ok: true, buildId: 'build-1', nativePrepared: 0, onlineCalls: 0,
    grant: { taskId: 'task-1', runId, instanceId, phase: 'main', configIdentity,
      epoch: 1, session: page.session, fromMs: 45_000, toMs: 85_000 }, results,
    inputs: [{ attemptId: 'attempt-1', items: results.map((row, i) => ({ id: row.taskId,
      text: row.originalText,
      owners: [{ ...[one, two][i], proofMediaTimeMs: 46_000 }] })) }],
    budget: { taskId: 'task-1', phases: { main: { runId, actualSent: { requests: 1, items: 2, utf16Chars: 6 },
      occupied: { requests: 1, items: 2, utf16Chars: 6 }, remaining: { requests: 99, items: 98, utf16Chars: 9994 } } },
    attempts: [{ attemptId: 'attempt-1', phase: 'main', runId, status: 'completed', items: 2 }],
    usage: { complete: false, reportedAttempts: 1 } } };
  return { page, host, one, two };
}

test('supplement analysis preserves its own full-range denominator and excludes prior-phase sends', () => {
  const { page, host } = fixture();
  host.grant.phase = 'supplement';
  host.budget.phases.supplement = host.budget.phases.main;
  host.budget.attempts[0].phase = 'supplement';
  host.budget.attempts.push({ attemptId: 'earlier-repair', phase: 'repair', runId: 'old-repair', status: 'completed', items: 1 });
  const result = analyzeBilibiliLivePreview({ page, host, phase: 'supplement' });
  assert.equal(result.ok, true, result.violations.join(', '));
  assert.deepEqual(result.range, { fromMs: 45_000, mainFromMs: 50_000, toMs: 85_000 });
  assert.equal(result.main.denominator, 2);
  assert.equal(result.cost.actualSent.requests, 1);
  assert.throws(() => analyzeBilibiliLivePreview({ page, host, phase: 'supplement', toMs: 65_000 }));
});

test('event and result denominators retain unadopted work with per-event causes', () => {
  const { page, host } = fixture();
  const result = analyzeBilibiliLivePreview({ page, host });
  assert.deepEqual(result.violations, []);
  assert.equal(result.main.denominator, 2);
  assert.equal(result.main.nominalReady, 1);
  assert.equal(result.main.lockReady, 1);
  assert.equal(result.main.adopted, 1);
  assert.equal(result.main.visible, 1);
  assert.equal(result.resultUtilization.uniqueNew, 2);
  assert.equal(result.resultUtilization.adopted, 1);
  assert.deepEqual(result.resultUtilization.unused[0].linkedEvents.map(row => row.reason), ['late-result']);
  assert.equal(result.tail.newRequestsAfterCutoff, 0);
  assert.equal(result.cost.usageKnown, false, 'A reported subset cannot prove complete usage');
});

test('terminal renderer reason overrides an unresolved ready result', () => {
  const { page, host } = fixture();
  const row = page.report.render.records[0];
  Object.assign(row, { state: 'environment-reset', reason: 'seeking', sourceMode: null,
    origin: null, renderSubmittedAtWallMs: null, textLockedAtWallMs: null });
  page.report.render.ui.domSamples = [];
  page.report.plan.B.events[0].state = 'revoked';
  const analysis = analyzeBilibiliLivePreview({ page, host });
  const unused = analysis.resultUtilization.unused.find(result => result.taskId === 'task-one');
  assert.deepEqual(unused.linkedEvents.map(row => row.reason), ['seeking']);
  row.reason = null;
  const reset = analyzeBilibiliLivePreview({ page, host });
  assert.equal(reset.resultUtilization.unused.find(result => result.taskId === 'task-one').linkedEvents[0].reason,
    'environment-reset');
});

test('strict t0 boundary, send proof, and provenance failures cannot become success', () => {
  const { page, host } = fixture();
  page.report.render.records[0].previewReadyAtMediaMs = 52_000;
  assert.equal(analyzeBilibiliLivePreview({ page, host }).main.nominalReady, 0);
  host.inputs[0].items[0].owners[0].proofMediaTimeMs = 85_000;
  const late = analyzeBilibiliLivePreview({ page, host });
  assert.equal(late.tail.newRequestsAfterCutoff, 1);
  assert.ok(late.violations.some(value => value.startsWith('invalid-send-proof')));
  host.inputs[0].items[0].owners[0].proofMediaTimeMs = 46_000;
  page.report.plan.B.previewReadyLog[0].originalText = 'mismatched source';
  assert.ok(analyzeBilibiliLivePreview({ page, host }).violations.some(value =>
    value.startsWith('invalid-preview-ready')));
});

test('ordinary status rejects text and a repair position is checked against its grant', () => {
  const { page } = fixture();
  const expected = { buildId: 'build-1', version: '0.4.19' };
  page.report.clock = { mediaTimeMs: 61_000, paused: true, seeking: false };
  assert.equal(assertLivePreviewPage(page, expected, { action: 'prepare', fromMs: 61_000 }), page);
  assert.throws(() => assertLivePreviewPage(page, expected, { action: 'prepare', fromMs: 45_000 }));
  page.report.plan.B.events[0].originalText = 'private';
  assert.throws(() => assertLivePreviewPage(page, expected, { action: 'status' }), /body/);
  const projection = projectLivePreviewReceipt(page, 'status', 1);
  assert.equal(projection.report.plan.B.events[0].originalText, undefined);
});

test('resume samples at two seconds, drains at 85, then keeps cost stable through tail', async () => {
  const { page, host } = fixture(), actions = [], sleeps = [], checkpoints = [];
  let mediaTimeMs = 45_000;
  const session = { runIssued: true, taskId: 'task-1', runId: 'run-1', instanceId: 'instance-1',
    ownedTargetTabId: 17, phaseName: 'main', fromMs: 45_000, toMs: 85_000,
    epoch: 1, analysisPath: 'already-analyzed' };
  host.grant.tabId = 17;
  const control = async (command, { action }) => {
    assert.equal(command, 'livePreview'); actions.push(action);
    if (action === 'status') mediaTimeMs = Math.min(103_000, mediaTimeMs + 2_000);
    if (action === 'drain') host.grant.state = 'draining';
    page.report.clock = { mediaTimeMs, seeking: false, playbackRate: 1, contentActive: true };
    page.report.state = mediaTimeMs >= 103_000 ? 'stopped' : 'running';
    const projected = structuredClone(page);
    for (const row of projected.report.plan.B.events) delete row.originalText;
    for (const row of projected.report.plan.B.previewReadyLog) {
      delete row.originalText; delete row.translatedText;
    }
    for (const row of projected.report.render.records) delete row.chosenText;
    return { ...projected, tailCutoff: mediaTimeMs >= 103_000 ? { state: 'stopped' } : null, host };
  };
  const result = await resumeLivePreview({ control, expected: { buildId: 'build-1', version: '0.4.19' }, session,
    checkpoint: async (phase, extra) => { checkpoints.push(phase); Object.assign(session, extra); },
    save: async name => name, sleep: async ms => { sleeps.push(ms); } });
  assert.equal(result.analyzed, true);
  assert.equal(actions.filter(value => value === 'drain').length, 1);
  assert.ok(actions.indexOf('drain') > actions.indexOf('status'));
  assert.ok(actions.indexOf('drain') < actions.lastIndexOf('status'));
  assert.ok(sleeps.length >= 20 && sleeps.every(value => value === LIVE_PREVIEW_SAMPLE_INTERVAL_MS));
  assert.ok(checkpoints.includes('tail-observed'));
  assert.equal(session.mainCost.requests, 1);
});

test('host restart records partial evidence and never replays start', async () => {
  const { host } = fixture(), calls = [], checkpoints = [];
  host.grant.tabId = 17; host.grant.state = 'stopped';
  const session = { runIssued: true, taskId: 'task-1', runId: 'run-1',
    ownedTargetTabId: 17, phaseName: 'main' };
  const result = await resumeLivePreview({
    control: async (_command, { action }) => { calls.push(action); return {
      partialEvidence: true, newCallsRevoked: true, page: null,
      pageError: 'target-document-unavailable', host };
    }, expected: { buildId: 'build-1' }, session,
    checkpoint: async (phase, extra) => { checkpoints.push(phase); Object.assign(session, extra); },
    save: async name => name,
  });
  assert.equal(result.partialEvidence, true);
  assert.deepEqual(calls, ['resume']);
  assert.deepEqual(checkpoints, ['partial-no-new-work']);
});

function pageStartedFixture() {
  const { page, host } = fixture(), actions = [], checkpoints = [];
  Object.assign(host.grant, { tabId: 17, state: 'draining', startedAt: 1234, modelIdentity: 'model-1' });
  Object.assign(page.report, { state: 'draining', clock: { mediaTimeMs: 85000, seeking: false,
    paused: false, playbackRate: 1, contentActive: true } });
  const session = { runIssued: false, taskId: 'task-1', runId: 'run-1', instanceId: 'instance-1',
    ownedTargetTabId: 17, phaseName: 'main', fromMs: 45000, toMs: 85000, epoch: 1,
    configIdentity: 'config-1', modelIdentity: 'model-1',
    pageSessionHash: settingsHash({ platform: page.session.platform, scenario: page.session.scenario,
      resourceId: page.session.resourceId, urlResourceId: null, sessionId: page.session.sessionId }) };
  let drained = false;
  const control = async (_command, { action }) => {
    actions.push(action);
    if (action === 'drain') drained = true;
    if (action === 'status' && drained) {
      page.report.clock.mediaTimeMs = 103000; page.report.state = 'stopped';
    }
    const reply = structuredClone(page);
    if (action !== 'export') {
      for (const row of reply.report.plan.B.events) delete row.originalText;
      for (const row of reply.report.plan.B.previewReadyLog) { delete row.originalText; delete row.translatedText; }
      for (const row of reply.report.render.records) delete row.chosenText;
    }
    return { ...reply, host };
  };
  return { host, page, session, actions, checkpoints, args: { control,
    expected: { buildId: 'build-1', version: '0.4.19' }, session,
    checkpoint: async (phase, extra) => { checkpoints.push(phase); Object.assign(session, extra); },
    save: async name => name, sleep: async () => {} } };
}

test('run and resume observe a page-button start without issuing another start or seek', async () => {
  for (const observe of [runLivePreview, resumeLivePreview]) {
    const h = pageStartedFixture();
    const result = await observe(h.args);
    assert.equal(result.analysis.completeEvidence, true);
    assert.equal(h.session.runIssued, true);
    assert.equal(h.session.startOrigin, 'page');
    assert.equal(h.session.startedAtMs, 1234);
    assert.equal(h.session.epoch, 1);
    assert.ok(h.checkpoints.includes('page-start-observed'));
    assert.equal(h.actions.some(action => ['run', 'start', 'play', 'seek', 'prepare'].includes(action)), false);
    assert.equal(h.host.budget.phases.main.actualSent.requests, 1);
  }
});

test('resume does not invent a start or adopt a different model or instance', async () => {
  for (const mutate of [
    h => { h.host.grant.startedAt = undefined; h.host.grant.state = 'prepared'; },
    h => { h.host.grant.modelIdentity = 'another-model'; },
    h => { h.host.grant.instanceId = 'another-instance'; },
  ]) {
    const h = pageStartedFixture(); mutate(h);
    await assert.rejects(resumeLivePreview(h.args));
    assert.equal(h.session.runIssued, false);
    assert.deepEqual(h.actions, ['resume']);
    assert.deepEqual(h.checkpoints, []);
  }
});

test('same-resource epoch change saves partial export and analysis without restarting playback', async () => {
  const { page, host } = fixture(), calls = [], checkpoints = [], saved = new Map();
  host.grant.tabId = 17; host.grant.state = 'running';
  const session = { runIssued: true, taskId: 'task-1', runId: 'run-1', instanceId: 'instance-1',
    ownedTargetTabId: 17, phaseName: 'main', fromMs: 45_000, toMs: 85_000, epoch: 1,
    pageSessionHash: settingsHash({ platform: page.session.platform, scenario: page.session.scenario,
      resourceId: page.session.resourceId, urlResourceId: null, sessionId: page.session.sessionId }) };
  page.epoch = 2; page.report.state = 'stopped'; page.report.reason = 'context-changed';
  page.report.clock = { mediaTimeMs: 55_100, seeking: false, playbackRate: 1, contentActive: true };
  page.tailCutoff = null; page.report.plan.B.supplyStopped = false;
  page.report.plan.B.events[0].state = 'revoked';
  Object.assign(page.report.render.records[0], { state: 'environment-reset', reason: 'seeking',
    sourceMode: null, origin: null, renderSubmittedAtWallMs: null, textLockedAtWallMs: null });
  page.report.render.ui.domSamples = [];
  const control = async (_command, { action }) => {
    calls.push(action);
    if (action === 'drain') { page.report.plan.B.supplyStopped = true; host.grant.state = 'draining'; }
    const reply = structuredClone(page);
    if (action !== 'export') {
      for (const row of reply.report.plan.B.events) delete row.originalText;
      for (const row of reply.report.plan.B.previewReadyLog) {
        delete row.originalText; delete row.translatedText;
      }
      for (const row of reply.report.render.records) delete row.chosenText;
    }
    return { ...reply, host: structuredClone(host) };
  };
  const result = await resumeLivePreview({ control, expected: { buildId: 'build-1', version: '0.4.19' },
    session, checkpoint: async (phase, extra) => { checkpoints.push(phase); Object.assign(session, extra); },
    save: async (name, value) => { saved.set(name, value); return name; },
    sleep: async () => { throw Error('must not resume sampling'); } });
  assert.deepEqual(calls, ['resume', 'drain', 'export']);
  assert.equal(result.partialEvidence, true);
  assert.equal(result.analysis.ok, false);
  assert.equal(result.analysis.completeEvidence, false);
  assert.deepEqual(result.analysis.interruption, { reason: 'context-changed', expectedEpoch: 1,
    observedEpoch: 2, observedState: 'stopped', observedMediaTimeMs: 55_100 });
  assert.equal(result.analysis.resultUtilization.unused.find(row => row.taskId === 'task-one').linkedEvents[0].reason,
    'seeking');
  assert.equal(saved.get('partial-interrupted-export').exported.epoch, 2);
  assert.deepEqual(checkpoints, ['partial-no-new-work']);
  assert.equal(session.epoch, 1, 'Original epoch remains the verified run identity');
});

test('environment stop within the original epoch is partial even without another seek', async () => {
  const { page, host } = fixture(), calls = [];
  host.grant.tabId = 17; host.grant.state = 'draining';
  page.report.state = 'stopped'; page.report.reason = 'context-changed';
  page.report.clock = { mediaTimeMs: 49_000, seeking: false, playbackRate: 1, contentActive: false };
  page.tailCutoff = null;
  const session = { runIssued: true, taskId: 'task-1', runId: 'run-1', instanceId: 'instance-1',
    ownedTargetTabId: 17, phaseName: 'main', fromMs: 45_000, toMs: 85_000, epoch: 1,
    pageSessionHash: settingsHash({ platform: page.session.platform, scenario: page.session.scenario,
      resourceId: page.session.resourceId, urlResourceId: null, sessionId: page.session.sessionId }) };
  const control = async (_command, { action }) => {
    calls.push(action);
    const reply = structuredClone(page);
    if (action === 'resume') {
      for (const row of reply.report.plan.B.events) delete row.originalText;
      for (const row of reply.report.plan.B.previewReadyLog) {
        delete row.originalText; delete row.translatedText;
      }
      for (const row of reply.report.render.records) delete row.chosenText;
    }
    return { ...reply, host };
  };
  const result = await resumeLivePreview({ control, expected: { buildId: 'build-1', version: '0.4.19' },
    session, checkpoint: async (_phase, extra) => Object.assign(session, extra),
    save: async name => name, sleep: async () => { throw Error('must not sample'); } });
  assert.deepEqual(calls, ['resume', 'export']);
  assert.equal(result.analysis.completeEvidence, false);
  assert.equal(result.analysis.interruption.expectedEpoch, result.analysis.interruption.observedEpoch);
});

test('host restart drains page demand before final stop and exports only after stopped', async () => {
  const order = [];
  const recovered = await recoverLivePreviewWithoutNewCalls({ pageReady: true,
    drainPage: async () => { order.push('page-drain'); return { report: { plan: { B: { supplyStopped: true } } } }; },
    stopHost: async () => { order.push('host-stop'); return { grant: { state: 'stopped' } }; },
    exportPage: async () => { order.push('page-export'); return { report: { plan: { B: { supplyStopped: true } } } }; },
  });
  assert.deepEqual(order, ['page-drain', 'host-stop', 'page-export']);
  assert.equal(recovered.pageSupplyStopped, true);
  assert.equal(recovered.host.grant.state, 'stopped');
  const absent = [];
  const missing = await recoverLivePreviewWithoutNewCalls({ pageReady: false,
    drainPage: async () => { absent.push('drain'); throw Error('must not touch page'); },
    stopHost: async () => { absent.push('stop'); return { grant: { state: 'stopped' } }; },
    exportPage: async () => { absent.push('export'); throw Error('must not touch page'); },
  });
  assert.deepEqual(absent, ['stop']);
  assert.equal(missing.pageSupplyStopped, false);
  assert.equal(missing.pageError, 'target-document-unavailable');
});

test('interrupted preparation closes only its recorded tab after guard release', async () => {
  const actions = [], protection = { persistentGuard: { present: false },
    temporaryGuard: { enabled: false } };
  const control = async (command, payload) => {
    actions.push(command === 'rpc' ? payload.type : command);
    if (command === 'rpc' && payload.type === 'build-identity') return { protections: protection };
    if (command === 'rpc' && payload.type === 'settings') return { settings: { enabled: false } };
    if (command === 'rpc' && payload.type === 'local-control') return { ok: true, state: { phase: 'idle' } };
    if (command === 'livePreview') return { ok: true, guardReleased: true,
      ownedTargetTabId: 17, closedTargetEvidence: { tabId: 17, exists: false },
      host: { ok: true, buildId: 'build-1', grant: null, activeRequests: 0 } };
    if (command === 'close-live-preview-owned') return { closed: true, tabId: 17 };
    throw Error('unexpected command');
  };
  const checkpoints = [], session = { taskId: 'task-1', runId: 'run-1', runIssued: false };
  await cleanupLivePreview({ control, expected: { buildId: 'build-1' }, session,
    checkpoint: async phase => { checkpoints.push(phase); }, save: async name => name });
  assert.deepEqual(actions, ['build-identity', 'livePreview', 'close-live-preview-owned',
    'settings', 'local-control', 'build-identity']);
  assert.deepEqual(checkpoints, ['guard-released', 'cleaned']);
});
