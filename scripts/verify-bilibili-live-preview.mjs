// Explicit, budgeted local B preview runner. No model calls occur on import or help.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, open, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, loadSession, writeSession } from './verify-bilibili-user-filters.mjs';
import { createBuildIdentity } from './build-identity.mjs';
import { writeJSON } from './bilibili-dispatch-ledger.mjs';
import { createBilibiliRunnerTransport } from './bilibili-runner-transport.mjs';
import { analyzeBilibiliLivePreview } from './bilibili-live-preview-analysis.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = resolve(ROOT, '../DanLingo-Workspace');
const EXTENSION = resolve(WORKSPACE, 'testing/current/extension');
export const LIVE_PREVIEW_ARTIFACT_ROOT = resolve(ROOT, '.artifacts/bilibili-live-preview/v1');
export const LIVE_PREVIEW_SAMPLE_INTERVAL_MS = 2_000;
export const LIVE_PREVIEW_RESOURCE = 'av117318021548752:cid42173138507';
const LOCK_PATH = resolve(ROOT, '.artifacts/bilibili-user-filters/runner.lock');
const ROUND = 'v1';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const optional = async path => readJSON(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
export const settingsHash = settings => createHash('sha256').update(JSON.stringify(settings)).digest('hex');
const identityHash = session => settingsHash({ platform: session.platform, scenario: session.scenario,
  resourceId: session.resourceId, urlResourceId: session.urlResourceId ?? null, sessionId: session.sessionId });

export function assertLivePreviewPage(reply, expected, { action = 'status', sessionHash, epoch, fromMs } = {}) {
  assert.equal(reply?.ok, true, `Live-preview page ${action} failed`);
  assert.equal(reply.version, expected.version, 'Live-preview page version mismatch');
  assert.equal(reply.buildId, expected.buildId, 'Live-preview page build mismatch');
  assert.equal(reply.session?.resourceId, LIVE_PREVIEW_RESOURCE, 'Live-preview resource/CID mismatch');
  assert.equal(reply.session?.platform, 'bilibili');
  assert.equal(reply.session?.scenario, 'video');
  assert.ok(typeof reply.session.sessionId === 'string' && reply.session.sessionId);
  assert.ok(Number.isSafeInteger(reply.epoch) && reply.epoch >= 0, 'Playback epoch missing');
  if (sessionHash) assert.equal(identityHash(reply.session), sessionHash, 'Live-preview page/document changed');
  if (epoch !== undefined) assert.equal(reply.epoch, epoch, 'Live-preview epoch changed');
  const report = reply.report;
  assert.equal(report?.coverage?.mainBuildId, expected.buildId, 'Live-preview coverage build mismatch');
  assert.equal(report.nativePrepared, 0, 'Native adapter received a result');
  assert.equal(report.adapterPrepared, 0, 'Native adapter prepared a result');
  assert.equal(report.nativeSettingsWrites, 0, 'Native settings changed');
  assert.equal(report.render?.contract, 'render-preview-v1', 'Preview renderer evidence missing');
  assert.ok(Number.isFinite(report.clock?.mediaTimeMs), 'Live-preview media clock missing');
  if (report.plan) {
    assert.ok(report.plan.B && !Object.hasOwn(report.plan, 'A'), 'Live preview must contain only B');
    assert.equal(report.plan.B.parameters?.limit, 2, 'B density changed');
  }
  if (action === 'prepare') {
    assert.equal(report.clock.paused, true, 'Prepare must remain paused');
    assert.equal(report.clock.seeking, false, 'Prepare seek incomplete');
    assert.ok(Number.isFinite(fromMs) && Math.abs(report.clock.mediaTimeMs - fromMs) < 250,
      'Prepare position differs from the host grant');
  }
  if (action === 'status') {
    const forbidden = new Set(['originalText', 'translatedText', 'sourceText', 'inputText', 'text',
      'body', 'contentText', 'author', 'authorName', 'authorId', 'uid', 'ruleValues', 'chosenText']);
    const body = value => Array.isArray(value) ? value.some(body)
      : value && typeof value === 'object' ? Object.entries(value).some(([key, item]) =>
        forbidden.has(key) && item !== undefined && item !== null || body(item)) : false;
    assert.equal(body(report) || body(reply.mainCutoff) || body(reply.tailCutoff), false,
      'Status or cutoffs contain source/translation body');
  }
  return reply;
}
export function assertLivePreviewHost(host, expected, { taskId, runId, tabId, instanceId, phase, state } = {}) {
  assert.equal(host?.ok, true, 'Live-preview host failed');
  assert.equal(host.buildId, expected.buildId, 'Live-preview host build mismatch');
  assert.equal(host.nativePrepared, 0, 'Host published to native adapter');
  assert.equal(host.onlineCalls, 0, 'Host used online transport');
  assert.ok(host.budget, 'Durable budget evidence missing');
  if (taskId) assert.equal(host.grant?.taskId, taskId);
  if (runId) assert.equal(host.grant?.runId, runId);
  if (tabId !== undefined) assert.equal(host.grant?.tabId, tabId);
  if (instanceId) assert.equal(host.grant?.instanceId, instanceId);
  if (phase) assert.equal(host.grant?.phase, phase);
  if (state) assert.equal(host.grant?.state, state);
  return host;
}
export function projectLivePreviewReceipt(reply, action, observedAtMs) {
  const report = reply.report ?? {}, host = reply.host ?? null;
  const numeric = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const plan = report.plan;
  const B = plan?.B;
  const select = (rows, fields) => (rows ?? []).map(row => Object.fromEntries(fields
    .filter(field => row[field] !== undefined).map(field => [field, row[field]])));
  const projectedPlan = B ? { evidence: plan.evidence, resourceId: plan.resourceId, epoch: plan.epoch,
    inputFrameCount: numeric(plan.inputFrameCount), inputTruncated: plan.inputTruncated === true,
    B: { evidence: B.evidence, parameters: B.parameters, totals: B.totals,
      supplyStopped: B.supplyStopped === true, supplyStopReason: B.supplyStopReason ?? '',
      subscriptions: numeric(B.subscriptions), activeSubscriptions: numeric(B.activeSubscriptions),
      transportSubmittedSubscriptions: numeric(B.transportSubmittedSubscriptions),
      previewReadyCount: numeric(B.previewReadyCount), truncated: B.truncated === true,
      events: select(B.events, ['id', 'sourceId', 'resourceId', 'epoch', 'mediaTimeMs', 'state',
        'unknown', 'needsTranslation', 'reason']),
      outcomes: select(B.outcomes, ['key', 'id', 'sourceId', 'epoch', 'mediaTimeMs', 'state', 'result']),
      transportRequestLog: select(B.transportRequestLog, ['requestId', 'key', 'id', 'sourceId',
        'resourceId', 'epoch', 'mediaTimeMs', 'requestedAtMs']),
      previewReadyLog: select(B.previewReadyLog, ['key', 'id', 'sourceId', 'resourceId', 'epoch',
        'mediaTimeMs', 'requestId', 'runId', 'instanceId', 'configIdentity', 'taskId', 'resultId',
        'kind', 'status', 'previewReadyAtMs']) } } : null;
  const grant = host?.grant;
  return { action, observedAtMs, buildId: reply.buildId, epoch: reply.epoch,
    session: reply.session && { platform: reply.session.platform, scenario: reply.session.scenario,
      resourceId: reply.session.resourceId, urlResourceId: reply.session.urlResourceId ?? null,
      sessionId: reply.session.sessionId },
    report: { coverage: { mainBuildId: report.coverage?.mainBuildId }, plan: projectedPlan,
      render: report.render ?? null, clock: report.clock ?? null, playback: report.playback ?? null,
      state: report.state, reason: report.reason, runId: report.runId, instanceId: report.instanceId,
      adapterPrepared: report.adapterPrepared, nativePrepared: report.nativePrepared,
      nativeSettingsWrites: report.nativeSettingsWrites,
      pageEvents: select(report.pageEvents, ['event', 'atMs', 'mediaTimeMs', 'id', 'sourceId', 'epoch', 't0',
        'requestId', 'taskId', 'resultId', 'reason']) },
    mainCutoff: reply.mainCutoff ?? null, tailCutoff: reply.tailCutoff ?? null,
    host: host && { ok: host.ok, buildId: host.buildId,
      grant: grant && { taskId: grant.taskId, runId: grant.runId, phase: grant.phase,
        instanceId: grant.instanceId, tabId: grant.tabId, epoch: grant.epoch, state: grant.state,
        fromMs: grant.fromMs, toMs: grant.toMs, modelName: grant.modelName ?? null,
        modelIdentity: grant.modelIdentity,
        configIdentity: grant.configIdentity, modelIdentityKind: grant.modelIdentityKind,
        modelLoads: grant.modelLoads, loadOwnership: grant.loadOwnership,
        startedAt: grant.startedAt ?? null,
        resumeCount: grant.resumeCount, session: grant.session, reason: grant.reason },
      budget: host.budget, activeRequests: host.activeRequests, nativePrepared: host.nativePrepared,
      onlineCalls: host.onlineCalls, localState: host.localState, errors: host.errors } };
}

async function receipt(control, session, action, expected, now, save, provided) {
  const result = provided ?? await control('livePreview', { action });
  assertLivePreviewPage(result, expected, { action: action === 'resume' ? 'status' : action,
    sessionHash: session.pageSessionHash, epoch: session.epoch });
  assertLivePreviewHost(result.host, expected, { taskId: session.taskId, runId: session.runId,
    tabId: session.ownedTargetTabId, instanceId: session.instanceId, phase: session.phaseName });
  assert.equal(result.host.grant.fromMs, session.fromMs);
  assert.equal(result.host.grant.toMs, session.toMs);
  await save(`${action}-status`, projectLivePreviewReceipt(result, action, now()));
  return result;
}
export async function prepareLivePreview({ control, expected, session, checkpoint, save,
  refreshConnection = async () => {}, sleep = delay }) {
  const before = await control('rpc', { type: 'settings' });
  assert.equal(before.settings?.enabled, false, 'Normal translation must remain disabled');
  assert.equal(before.settings?.backend, 'local', 'Select the current local model');
  assert.ok(before.settings?.localModelId, 'No selected local model');
  const savedSettingsHash = settingsHash(before.settings);
  let identity = await control('rpc', { type: 'build-identity' });
  assert.equal(identity.idle, true, 'Background must be idle before preparation');
  if (identity.buildId !== expected.buildId || identity.version !== expected.version) {
    await checkpoint('reloading', { savedSettingsHash });
    await control('reload'); await sleep(500); await refreshConnection();
    identity = await control('rpc', { type: 'build-identity' });
  }
  assert.equal(identity.buildId, expected.buildId, 'Background build mismatch');
  assert.equal(identity.version, expected.version, 'Background version mismatch');
  assert.equal(identity.idle, true, 'Reloaded background is busy');
  const after = await control('rpc', { type: 'settings' });
  assert.equal(settingsHash(after.settings), savedSettingsHash, 'Saved settings changed during preparation');
  const prepared = await control('livePreview', { action: 'prepare', taskId: session.taskId,
    runId: session.runId, phase: session.phaseName,
    ...(session.phaseName !== 'main' ? { repairReason: session.repairReason,
      fromMs: session.fromMs, toMs: session.toMs } : {}) }, 120_000);
  assertLivePreviewHost(prepared.host, expected, { taskId: session.taskId, runId: session.runId,
    tabId: prepared.ownedTargetTabId, phase: session.phaseName, state: 'prepared' });
  assert.equal(prepared.host.grant.epoch, prepared.epoch);
  assert.equal(prepared.host.grant.session?.resourceId, LIVE_PREVIEW_RESOURCE);
  assert.equal(prepared.host.grant.modelId, before.settings.localModelId,
    'The selected local model changed');
  assert.ok(prepared.host.grant.modelIdentity && prepared.host.grant.configIdentity);
  assert.equal(prepared.host.grant.fromMs, session.fromMs);
  assert.equal(prepared.host.grant.toMs, session.toMs);
  assertLivePreviewPage(prepared.preparedPage, expected,
    { action: 'prepare', fromMs: prepared.host.grant.fromMs });
  assertLivePreviewPage(prepared, expected, { action: 'bind', epoch: prepared.host.grant.epoch });
  assert.equal(prepared.report.runId, session.runId);
  assert.equal(prepared.report.instanceId, prepared.host.grant.instanceId);
  const pageSessionHash = identityHash(prepared.session);
  await save('prepared-full', { page: prepared.preparedPage, bound: prepared,
    buildIdentity: identity });
  await save('prepared', projectLivePreviewReceipt(prepared, 'prepare', Date.now()));
  await checkpoint('prepared', { savedSettingsHash, expectedBuildId: expected.buildId,
    expectedVersion: expected.version, sourceHash: expected.sourceHash, pageSessionHash,
    ownedTargetTabId: prepared.ownedTargetTabId, epoch: prepared.epoch,
    instanceId: prepared.host.grant.instanceId, modelIdentity: prepared.host.grant.modelIdentity,
    configIdentity: prepared.host.grant.configIdentity, runIssued: false });
  return prepared;
}

const sent = (host, phase) => host.budget?.phases?.[phase]?.actualSent;
const sameCost = (a, b) => a && b && ['requests', 'items', 'utf16Chars'].every(key => a[key] === b[key]);
async function adoptPageStartedRun(reply, expected, session, checkpoint) {
  assert.ok(session.pageSessionHash && session.instanceId, 'Prepare the live preview first');
  assertLivePreviewHost(reply.host, expected, { taskId: session.taskId, runId: session.runId,
    tabId: session.ownedTargetTabId, instanceId: session.instanceId, phase: session.phaseName });
  const grant = reply.host.grant;
  assert.equal(grant.epoch, session.epoch, 'Original start epoch changed');
  assert.equal(identityHash(grant.session), session.pageSessionHash, 'Started document changed');
  assert.equal(grant.fromMs, session.fromMs); assert.equal(grant.toMs, session.toMs);
  assert.equal(grant.configIdentity, session.configIdentity, 'Started configuration changed');
  assert.equal(grant.modelIdentity, session.modelIdentity, 'Started model changed');
  assert.ok(Number.isFinite(grant.startedAt) && grant.startedAt > 0 &&
    ['running', 'draining', 'stopped'].includes(grant.state), 'No explicit page start to resume');
  if (reply.partialEvidence !== true) {
    assertLivePreviewPage(reply, expected, { action: 'status', sessionHash: session.pageSessionHash });
    assert.equal(reply.report.runId, session.runId);
    assert.equal(reply.report.instanceId, session.instanceId);
  }
  await checkpoint('page-start-observed', { runIssued: true, startOrigin: 'page', startedAtMs: grant.startedAt });
}
export async function runLivePreview({ control, expected, session, checkpoint, save,
  now = Date.now, sleep = delay }) {
  assert.equal(session.runIssued, false, 'Run may only be issued once; use resume');
  assert.ok(session.pageSessionHash && session.instanceId, 'Prepare the live preview first');
  const observed = await control('livePreview', { action: 'status' });
  if (observed.host?.grant?.state !== 'prepared' && observed.host?.grant?.startedAt) {
    await adoptPageStartedRun(observed, expected, session, checkpoint);
    return resumeLivePreview({ control, expected, session, checkpoint, save, now, sleep });
  }
  const before = await receipt(control, session, 'status', expected, now, save, observed);
  assert.equal(before.host.grant.state, 'prepared', 'Run is not prepared');
  assert.equal(before.report.clock.paused, true, 'Run must begin paused');
  assert.ok(Math.abs(before.report.clock.mediaTimeMs - session.fromMs) < 250,
    'Run start position changed');
  await checkpoint('run-issuing', { runIssued: true });
  const started = await receipt(control, session, 'run', expected, now, save);
  assert.equal(started.host.grant.state, 'running', 'Host did not start');
  await checkpoint('running', { runIssued: true, startedAtMs: now() });
  return resumeLivePreview({ control, expected, session, checkpoint, save, now, sleep });
}
function interruptedSameOwner(reply, session) {
  const grant = reply?.host?.grant;
  if (reply?.ok !== true || reply.session?.resourceId !== LIVE_PREVIEW_RESOURCE ||
      identityHash(reply.session) !== session.pageSessionHash ||
      grant?.taskId !== session.taskId || grant.runId !== session.runId ||
      grant.tabId !== session.ownedTargetTabId || grant.instanceId !== session.instanceId ||
      grant.epoch !== session.epoch || reply.report?.runId !== session.runId ||
      reply.report?.instanceId !== session.instanceId) return false;
  return reply.epoch !== session.epoch ||
    ['stopped', 'draining'].includes(reply.report.state) &&
      Number.isFinite(reply.report.clock?.mediaTimeMs) && reply.report.clock.mediaTimeMs < session.toMs;
}
async function captureInterruptedLivePreview({ control, expected, session, checkpoint, save, now, analyze,
  observed }) {
  const check = (reply, action) => {
    assertLivePreviewPage(reply, expected, { action, sessionHash: session.pageSessionHash });
    assertLivePreviewHost(reply.host, expected, { taskId: session.taskId, runId: session.runId,
      tabId: session.ownedTargetTabId, instanceId: session.instanceId, phase: session.phaseName });
    assert.equal(reply.host.grant.epoch, session.epoch, 'Original host grant epoch changed');
    assert.equal(reply.report.runId, session.runId);
    assert.equal(reply.report.instanceId, session.instanceId);
    return reply;
  };
  check(observed, 'export');
  let drained = observed;
  if (observed.report.plan?.B?.supplyStopped !== true ||
      !['draining', 'stopped'].includes(observed.host.grant.state))
    drained = check(await control('livePreview', { action: 'drain' }), 'drain');
  assert.equal(drained.report.plan?.B?.supplyStopped, true, 'Interrupted page still supplies demand');
  assert.ok(['draining', 'stopped'].includes(drained.host.grant.state), 'Interrupted host still sends');
  const exported = check(await control('livePreview', { action: 'export' }), 'export');
  assert.ok(sameCost(sent(drained.host, session.phaseName), sent(exported.host, session.phaseName)),
    'Provider transport grew after interrupted drain');
  const partialPath = await save('partial-interrupted-export', { observed:
    projectLivePreviewReceipt(observed, 'interrupted', now()), drained:
    projectLivePreviewReceipt(drained, 'drain', now()), exported });
  const measured = exported.report.plan?.B ? analyze({ page: exported, host: exported.host,
    phase: session.phaseName, fromMs: session.fromMs, toMs: session.toMs }) :
    { violations: ['partial-plan-unavailable'], events: [], main: null, coldStart: null,
      resultUtilization: null, cost: null };
  const analysis = { ...measured, ok: false, completeEvidence: false,
    violations: [...new Set([...(measured.violations ?? []), 'interrupted-before-run-complete'])],
    interruption: { reason: exported.report.reason ?? 'epoch-or-environment-changed',
      expectedEpoch: session.epoch, observedEpoch: exported.epoch,
      observedState: exported.report.state, observedMediaTimeMs: exported.report.clock?.mediaTimeMs ?? null } };
  const partialAnalysisPath = await save('partial-interrupted-analysis', analysis);
  await checkpoint('partial-no-new-work', { partialPath, partialAnalysisPath,
    partialReason: analysis.interruption.reason, completeEvidence: false, runIssued: true });
  return { partialEvidence: true, partialPath, partialAnalysisPath, analysis };
}
export async function resumeLivePreview({ control, expected, session, checkpoint, save,
  now = Date.now, sleep = delay, analyze = analyzeBilibiliLivePreview }) {
  if (session.partialPath) return { partialEvidence: true, partialPath: session.partialPath,
    partialAnalysisPath: session.partialAnalysisPath ?? null };
  const response = await control('livePreview', { action: 'resume' });
  if (!session.runIssued) await adoptPageStartedRun(response, expected, session, checkpoint);
  if (response.partialEvidence === true) {
    assert.equal(response.newCallsRevoked, true, 'Recovery did not revoke new calls');
    assertLivePreviewHost(response.host, expected, { taskId: session.taskId, runId: session.runId,
      tabId: session.ownedTargetTabId, phase: session.phaseName, state: 'stopped' });
    const partialPath = await save('partial-recovery-export', response);
    await checkpoint('partial-no-new-work', { partialPath, partialReason: response.pageError ??
      'Host restarted; in-memory result evidence is unavailable', runIssued: true });
    return { partialEvidence: true, partialPath };
  }
  if (interruptedSameOwner(response, session)) return captureInterruptedLivePreview({ control,
    expected, session, checkpoint, save, now, analyze, observed: response });
  let status = await receipt(control, session, 'resume', expected, now, save, response);
  const started = now();
  if (!session.mainCutoffPath) {
    for (let sample = 0; status.report.clock.mediaTimeMs < session.toMs; sample++) {
      assert.ok(sample < 40 && now() - started <= 90_000, 'Main playback did not reach its cutoff');
      assert.ok(['running', 'paused', 'draining'].includes(status.report.state), 'Live preview stopped early');
      assert.equal(status.report.clock.seeking, false, 'Playback sought during live sample');
      assert.equal(status.report.clock.playbackRate, 1, 'Playback speed changed');
      assert.equal(status.report.clock.contentActive, true, 'Video left the active content');
      await sleep(LIVE_PREVIEW_SAMPLE_INTERVAL_MS);
      const observed = await control('livePreview', { action: 'status' });
      if (interruptedSameOwner(observed, session)) return captureInterruptedLivePreview({ control,
        expected, session, checkpoint, save, now, analyze, observed });
      status = await receipt(control, session, 'status', expected, now, save, observed);
      await checkpoint('sampling', { sampleCount: sample + 1, lastMediaTimeMs: status.report.clock.mediaTimeMs });
    }
    const observed = await control('livePreview', { action: 'drain' });
    if (interruptedSameOwner(observed, session)) return captureInterruptedLivePreview({ control,
      expected, session, checkpoint, save, now, analyze, observed });
    status = await receipt(control, session, 'drain', expected, now, save, observed);
    assert.ok(['draining', 'stopped'].includes(status.host.grant.state), 'Host did not revoke new sends');
    const mainCutoffPath = await save('main-cutoff', projectLivePreviewReceipt(status, 'drain', now()));
    await checkpoint('draining', { mainCutoffPath, mainCost: sent(status.host, session.phaseName) });
  }
  const mainCost = session.mainCost;
  if (!session.tailCutoffPath) {
    const tailStart = now();
    while (status.report.clock.mediaTimeMs < Math.min(session.toMs + 18_000, 103_000) &&
        status.report.state !== 'stopped') {
      assert.ok(now() - tailStart <= 30_000, 'Tail observation did not complete');
      await sleep(LIVE_PREVIEW_SAMPLE_INTERVAL_MS);
      const observed = await control('livePreview', { action: 'status' });
      if (interruptedSameOwner(observed, session)) return captureInterruptedLivePreview({ control,
        expected, session, checkpoint, save, now, analyze, observed });
      status = await receipt(control, session, 'status', expected, now, save, observed);
      assert.ok(sameCost(mainCost, sent(status.host, session.phaseName)),
        'Provider transport grew after the main cutoff');
    }
    const tailCutoffPath = await save('tail-cutoff', projectLivePreviewReceipt(status, 'tail', now()));
    assert.ok(status.tailCutoff, 'Page did not record the tail cutoff');
    await checkpoint('tail-observed', { tailCutoffPath });
  }
  if (!session.analysisPath) {
    const observed = await control('livePreview', { action: 'export' });
    if (interruptedSameOwner(observed, session)) return captureInterruptedLivePreview({ control,
      expected, session, checkpoint, save, now, analyze, observed });
    const exported = await receipt(control, session, 'export', expected, now, save, observed);
    assert.ok(sameCost(mainCost, sent(exported.host, session.phaseName)),
      'Provider transport grew during export');
    const exportPath = await save('full-local-export', exported);
    const analysis = analyze({ page: exported, host: exported.host, phase: session.phaseName,
      fromMs: session.fromMs, toMs: session.toMs });
    const analysisPath = await save('analysis', analysis);
    await checkpoint('analyzed', { exportPath, analysisPath, analysisOk: analysis.ok,
      completeEvidence: analysis.completeEvidence });
    return { analysis, export: exported };
  }
  return { resumed: true, analyzed: true, analysisPath: session.analysisPath };
}
export async function cleanupLivePreview({ control, expected, session, checkpoint, save,
  now = Date.now }) {
  const protectionBefore = await control('rpc', { type: 'build-identity' });
  await save('cleanup-protections-before', protectionBefore);
  const result = session.cleanupConfirmed ? null :
    await control('livePreview', { action: 'cleanup' }, 120_000);
  if (!result) {
    assert.ok(Number.isSafeInteger(session.ownedTargetTabId), 'Cleanup owner tab was not recorded');
    const closed = await control('close-live-preview-owned');
    if (closed.closed) assert.equal(closed.tabId, session.ownedTargetTabId);
    else assert.equal(session.ownedTargetClosed, true, 'Confirmed cleanup still owns a target');
    const settings = await control('rpc', { type: 'settings' });
    if (session.savedSettingsHash) assert.equal(settingsHash(settings.settings), session.savedSettingsHash);
    const protectionAfter = await control('rpc', { type: 'build-identity' });
    assert.deepEqual(protectionAfter.protections?.persistentGuard,
      protectionBefore.protections?.persistentGuard);
    assert.equal(protectionAfter.protections?.temporaryGuard?.enabled, false);
    await checkpoint('cleaned', { ownedTargetClosed: true, savedSettingsUnchanged: true });
    return { result: { report: { restored: session.pageRestored === true },
      closedTargetEvidence: session.closedTargetEvidence ?? null },
    closed: { closed: true, tabId: session.ownedTargetTabId } };
  }
  const tabId = session.ownedTargetTabId ?? result.ownedTargetTabId;
  assert.ok(Number.isSafeInteger(tabId), 'Recorded live-preview tab is missing');
  assert.equal(result.ownedTargetTabId, tabId, 'Cleanup returned another tab');
  if (result.host?.grant) assertLivePreviewHost(result.host, expected, {
    taskId: session.taskId, runId: session.runId, tabId, state: 'stopped' });
  else {
    assert.equal(session.runIssued, false, 'A started run lost its host grant');
    assert.equal(result.host?.ok, true, 'Interrupted prepare host cleanup failed');
    assert.equal(result.host.buildId, expected.buildId);
  }
  assert.equal(result.host.activeRequests, 0, 'Host requests remain active');
  assert.equal(result.guardReleased, true, 'Temporary guard was not released');
  if (!result.closedTargetEvidence) {
    assertLivePreviewPage(result, expected, { action: 'cleanup', sessionHash: session.pageSessionHash });
    assert.equal(result.report.restored, true, 'Page restoration failed');
    const ui = result.report.render.ui;
    for (const key of ['activeNodes', 'measurementNodes', 'visibilityListenerCount',
      'detailsListenerCount', 'fontListenerCount', 'motionListenerCount'])
      assert.equal(ui[key], 0, `Preview ${key} remains active`);
    for (const key of ['enabled', 'rafActive', 'intersectionActive', 'resizeActive'])
      assert.equal(ui[key], false, `Preview ${key} remains active`);
  }
  await save('cleanup-full', result);
  await save('cleanup', projectLivePreviewReceipt(result, 'cleanup', now()));
  await checkpoint('guard-released', { cleanupConfirmed: true, ownedTargetTabId: tabId,
    pageRestored: result.report?.restored === true,
    closedTargetEvidence: result.closedTargetEvidence ?? null });
  const closed = await control('close-live-preview-owned');
  assert.equal(closed.closed, true, 'Only the owned target may be closed');
  assert.equal(closed.tabId, tabId);
  const settings = await control('rpc', { type: 'settings' });
  const local = await control('rpc', { type: 'local-control', control: { action: 'state' } });
  const protectionAfter = await control('rpc', { type: 'build-identity' });
  assert.deepEqual(protectionAfter.protections?.persistentGuard,
    protectionBefore.protections?.persistentGuard, 'Persistent guard changed during cleanup');
  assert.equal(protectionAfter.protections?.temporaryGuard?.enabled, false,
    'Temporary live-preview protection remains');
  await save('cleanup-final-state', { local, protections: protectionAfter.protections });
  if (session.savedSettingsHash) assert.equal(settingsHash(settings.settings), session.savedSettingsHash,
    'Saved settings changed during live preview');
  await checkpoint('cleaned', { ownedTargetClosed: true, savedSettingsUnchanged: true });
  return { result, closed };
}

async function acquireLock() {
  await mkdir(dirname(LOCK_PATH), { recursive: true });
  try { return await open(LOCK_PATH, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = await readJSON(LOCK_PATH);
    assert.ok(Number.isSafeInteger(prior.pid) && prior.pid > 0, 'Unrecognized runner lock');
    try { process.kill(prior.pid, 0); throw Error(`Runner process ${prior.pid} still exists`); }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
    await unlink(LOCK_PATH); return open(LOCK_PATH, 'wx');
  }
}
async function ensureBuild(session) {
  let deployed = await optional(resolve(EXTENSION, 'runtime-identity.json'));
  if (!deployed || deployed.sourceHash !== createBuildIdentity(ROOT).sourceHash) {
    await writeSession(session, 'building');
    const log = await open(resolve(session.folder, 'build.log'), 'a');
    try { await new Promise((yes, no) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        resolve(WORKSPACE, 'tools/Update-TestBuild.ps1')],
      { cwd: ROOT, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
      child.on('error', no);
      child.on('exit', code => code === 0 ? yes() : no(Error(`Updater failed (${code}); see build.log`)));
    }); } finally { await log.close(); }
    deployed = await readJSON(resolve(EXTENSION, 'runtime-identity.json'));
  }
  assert.equal(deployed.sourceHash, createBuildIdentity(ROOT).sourceHash, 'Source changed during build');
  return deployed;
}
export function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  assert.ok(['help', 'prepare', 'run', 'resume', 'cleanup'].includes(command), 'Unknown live-preview action');
  if (command !== 'prepare') { assert.equal(rest.length, 0, 'Unexpected arguments'); return { command }; }
  if (!rest.length) return { command, phase: 'main' };
  if (rest[0] === '--phase' && rest[1] === 'supplement') {
    assert.equal(rest.length, 4, 'Supplement requires only its explicit authorization reason');
    assert.equal(rest[2], '--reason', 'Supplement requires --reason');
    assert.ok(rest[3]?.trim() && rest[3].length <= 500, 'Supplement authorization reason required');
    return { command, phase: 'supplement', repairReason: rest[3], fromMs: 45_000, toMs: 85_000 };
  }
  assert.deepEqual(rest.slice(0, 2), ['--phase', 'repair'], 'Repair requires --phase repair');
  assert.deepEqual(rest.slice(2).filter((_, index) => index % 2 === 0).sort(),
    ['--from-ms', '--reason', '--to-ms'].sort(), 'Repair requires reason and range');
  const values = Object.fromEntries(rest.slice(2).filter((_, index) => index % 2 === 0)
    .map((key, index) => [key, rest[3 + index * 2]]));
  const fromMs = Number(values['--from-ms']), toMs = Number(values['--to-ms']);
  assert.ok(Number.isSafeInteger(fromMs) && Number.isSafeInteger(toMs) && fromMs >= 45_000 &&
    toMs > fromMs && toMs <= 85_000 && toMs - fromMs <= 20_000,
  'Repair must stay inside [45,85) and last at most 20 seconds');
  assert.ok(values['--reason']?.trim(), 'Repair reason required');
  return { command, phase: 'repair', repairReason: values['--reason'], fromMs, toMs };
}
export function assertNextLivePreviewPhase(prior, args) {
  if (args.phase === 'supplement') {
    assert.ok(prior?.phase === 'cleaned' && prior.phaseName === 'repair' && prior.repairUsed === true &&
      !prior.supplementUsed && prior.runIssued && prior.analysisPath && prior.cleanupConfirmed,
    'Supplement requires the analyzed, cleaned repair and can be used only once');
    return;
  }
  if (prior && (args.phase !== 'repair' || prior.repairUsed || prior.supplementUsed || prior.phaseName !== 'main'))
    throw Error('Main run is spent; only the unused, explicitly reasoned follow-up is allowed');
  if (prior && (!prior.runIssued || !(prior.analysisPath || prior.partialAnalysisPath)))
    throw Error('Repair requires an analyzed, cleaned main run');
  if (!prior && args.phase === 'repair') throw Error('Repair requires a completed main task');
}
async function main(argv) {
  const args = parseArgs(argv);
  if (args.command === 'help') {
    console.log('Usage: node scripts/verify-bilibili-live-preview.mjs prepare|run|resume|cleanup');
    console.log('Repair: prepare --phase repair --reason <reason> --from-ms <start> --to-ms <end>');
    console.log('Explicitly authorized extra run: prepare --phase supplement --reason <authorization>');
    return;
  }
  const prior = await loadSession(LIVE_PREVIEW_ARTIFACT_ROOT, ROUND);
  if (args.command === 'cleanup' && (!prior || prior.phase === 'cleaned')) return;
  await mkdir(LIVE_PREVIEW_ARTIFACT_ROOT, { recursive: true });
  const lock = await acquireLock(), transport = createBilibiliRunnerTransport();
  let session = prior;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    if (args.command === 'prepare' && (!prior || prior.phase === 'cleaned')) {
      assertNextLivePreviewPhase(prior, args);
      session = await createSession(LIVE_PREVIEW_ARTIFACT_ROOT, ROUND);
      Object.assign(session, { taskId: prior?.taskId ?? randomUUID(), runId: randomUUID(),
        phaseName: args.phase, fromMs: args.phase === 'main' ? 45_000 : args.fromMs,
        toMs: args.phase === 'main' ? 85_000 : args.toMs,
        repairReason: args.repairReason, repairUsed: prior?.repairUsed === true || args.phase === 'repair',
        supplementUsed: prior?.supplementUsed === true || args.phase === 'supplement',
        ...(prior ? { priorRunId: prior.runId, priorSessionId: prior.id } : {}) });
      await writeSession(session, 'created');
    }
    if (!session) throw Error('Prepare a live-preview task first');
    if (args.command === 'run' && session.runIssued) throw Error('Run already issued; use resume');
    if (args.command !== 'cleanup' && session.phase === 'cleaned') throw Error('Task already cleaned');
    const expected = args.command === 'cleanup'
      ? await readJSON(resolve(EXTENSION, 'runtime-identity.json'))
      : args.command === 'prepare' && !session.expectedBuildId
      ? await ensureBuild(session) : session.expectedBuildId
        ? { buildId: session.expectedBuildId, version: session.expectedVersion, sourceHash: session.sourceHash }
        : await readJSON(resolve(EXTENSION, 'runtime-identity.json'));
    await transport.connect();
    const control = (...parts) => transport.control(...parts);
    const checkpoint = (phase, extra) => writeSession(session, phase, extra);
    const save = async (name, result) => {
      const path = resolve(session.folder,
        `${String(session.seq).padStart(4, '0')}-${name}-${randomUUID().slice(0, 8)}.json`);
      await writeJSON(path, { at: new Date().toISOString(), result }); return path;
    };
    if (args.command === 'prepare') {
      if (session.pageSessionHash) {
        const current = await control('livePreview', { action: 'status' });
        assertLivePreviewPage(current, expected, { sessionHash: session.pageSessionHash, epoch: session.epoch });
        assertLivePreviewHost(current.host, expected, { taskId: session.taskId, runId: session.runId });
      } else await prepareLivePreview({ control, expected, session, checkpoint, save,
        refreshConnection: async () => { transport.openPage(); await transport.waitHello(30_000); } });
      console.log(JSON.stringify({ phase: 'prepared', directory: session.folder,
        targetTabId: session.ownedTargetTabId, taskId: session.taskId, runId: session.runId }));
    } else if (args.command === 'run') {
      console.log(JSON.stringify({ phase: 'running', targetTabId: session.ownedTargetTabId,
        taskId: session.taskId, runId: session.runId }));
      const outcome = await runLivePreview({ control, expected, session, checkpoint, save });
      console.log(JSON.stringify({ phase: outcome.partialEvidence ? 'partial-no-new-work' : 'analyzed',
        directory: session.folder, analysisPath: session.analysisPath ?? null,
        summary: outcome.analysis && { main: outcome.analysis.main,
          coldStart: outcome.analysis.coldStart, resultUtilization: outcome.analysis.resultUtilization,
          cost: outcome.analysis.cost, violations: outcome.analysis.violations } }));
    } else if (args.command === 'resume') {
      console.log(JSON.stringify({ phase: 'resuming', targetTabId: session.ownedTargetTabId,
        taskId: session.taskId, runId: session.runId }));
      const outcome = await resumeLivePreview({ control, expected, session, checkpoint, save });
      console.log(JSON.stringify({ phase: outcome.partialEvidence ? 'partial-no-new-work' : 'analyzed',
        directory: session.folder, analysisPath: session.analysisPath ?? null,
        partialPath: outcome.partialPath ?? null,
        summary: outcome.analysis && { main: outcome.analysis.main,
          coldStart: outcome.analysis.coldStart, resultUtilization: outcome.analysis.resultUtilization,
          cost: outcome.analysis.cost, violations: outcome.analysis.violations } }));
    } else {
      const outcome = await cleanupLivePreview({ control, expected, session, checkpoint, save });
      console.log(JSON.stringify({ phase: 'cleaned', directory: session.folder,
        targetTabId: outcome.closed.tabId, pageRestored: outcome.result.report?.restored === true,
        closedTargetEvidence: outcome.result.closedTargetEvidence ?? null }));
    }
  } catch (error) {
    const message = transport.redact(error instanceof Error ? error.message : String(error));
    if (session && session.phase !== 'cleaned') await writeSession(session, 'attention-required', { error: message, resumePhase: session.phase });
    else console.error(message);
    process.exitCode = 1;
  } finally { await transport.close(); await lock.close(); await unlink(LOCK_PATH); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
