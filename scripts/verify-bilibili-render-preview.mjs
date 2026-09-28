// Fixed Bilibili render-preview verification. Page rendering is measured locally; provider transports stay guarded.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, open, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, loadSession, writeSession } from './verify-bilibili-user-filters.mjs';
import { createBuildIdentity } from './build-identity.mjs';
import { writeJSON } from './bilibili-dispatch-ledger.mjs';
import { analyzeBilibiliRenderPreview } from './bilibili-render-preview-analysis.mjs';
import { createBilibiliRunnerTransport } from './bilibili-runner-transport.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = resolve(ROOT, '../DanLingo-Workspace');
const EXTENSION = resolve(WORKSPACE, 'testing/current/extension');
const ARTIFACT = resolve(ROOT, '.artifacts/bilibili-render-preview');
export const RENDER_PREVIEW_ARTIFACT_ROOT = resolve(ARTIFACT, 'v1');
export const RENDER_PREVIEW_DURATION_MS = 35_000;
export const RENDER_PREVIEW_SAMPLE_INTERVAL_MS = 3_000;
const ROUND = 'v1';
const LOCK_PATH = resolve(ROOT, '.artifacts/bilibili-user-filters/runner.lock');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const optional = async path => readJSON(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
export const settingsHash = settings => createHash('sha256').update(JSON.stringify(settings)).digest('hex');

export function renderPreviewPageSessionHash(session) {
  assert.ok(session && session.platform === 'bilibili' && session.scenario === 'video' &&
    typeof session.resourceId === 'string' && session.resourceId &&
    typeof session.sessionId === 'string' && session.sessionId, 'Render-preview page session identity is incomplete');
  return settingsHash({ platform: session.platform, scenario: session.scenario, resourceId: session.resourceId,
    urlResourceId: session.urlResourceId ?? null, sessionId: session.sessionId });
}

function canonicalPersistentGuard(value) {
  assert.ok(value && typeof value.key === 'string' && value.key && typeof value.present === 'boolean' &&
    typeof value.enabled === 'boolean' && (value.declaredEnabled === null || typeof value.declaredEnabled === 'boolean') &&
    (value.kind === null || typeof value.kind === 'string') &&
    (value.ownerTabId === null || Number.isSafeInteger(value.ownerTabId) && value.ownerTabId >= 0) &&
    !Object.hasOwn(value, 'value'), 'Persistent guard summary is invalid or contains its underlying value');
  return { key: value.key, present: value.present, enabled: value.enabled,
    declaredEnabled: value.declaredEnabled, kind: value.kind, ownerTabId: value.ownerTabId };
}

function protectionsOf(source) {
  const protections = source?.protections ?? source;
  const temporary = protections?.temporaryGuard;
  assert.ok(temporary && typeof temporary.enabled === 'boolean' &&
    (temporary.kind === null || typeof temporary.kind === 'string') &&
    (temporary.ownerTabId === null || Number.isSafeInteger(temporary.ownerTabId) && temporary.ownerTabId >= 0) &&
    typeof protections.effectiveZeroTransport === 'boolean', 'Render-preview guard summary is missing');
  return { temporaryGuard: { enabled: temporary.enabled, kind: temporary.kind, ownerTabId: temporary.ownerTabId },
    persistentGuard: canonicalPersistentGuard(protections.persistentGuard),
    effectiveZeroTransport: protections.effectiveZeroTransport };
}

function assertCacheState(value) {
  assert.ok(value && typeof value.available === 'boolean', 'Render-preview cache state is missing');
  if (!value.available) return { available: false };
  assert.ok(typeof value.databaseExists === 'boolean' && Number.isSafeInteger(value.entries) && value.entries >= 0 &&
    typeof value.metadataHash === 'string' && /^[a-f0-9]{64}$/i.test(value.metadataHash),
  'Render-preview cache state summary is invalid');
  return { available: true, databaseExists: value.databaseExists, entries: value.entries,
    metadataHash: value.metadataHash };
}

export function assertRenderPreviewBackground(receipt, expectedBuildId, expectedVersion,
  { action = 'status', tabId, persistentGuard } = {}) {
  assert.equal(receipt?.ok, true, `Render-preview background ${action} was not accepted`);
  assert.equal(receipt.version, expectedVersion, 'Render-preview background version changed');
  assert.equal(receipt.buildId, expectedBuildId, 'Render-preview background build changed');
  assert.equal(receipt.actualModelCalls, 0, 'Model call budget violated');
  assert.ok(Number.isSafeInteger(receipt.blockedTransports) && receipt.blockedTransports >= 0,
    'Blocked transport counter is missing');
  assert.equal(receipt.idle, true, 'Background did not remain idle');
  const protections = protectionsOf(receipt);
  if (persistentGuard) assert.deepEqual(protections.persistentGuard, persistentGuard,
    'Persistent zero-transport guard changed');
  assert.equal(receipt.zeroModelGuard, protections.temporaryGuard.enabled,
    'Temporary guard receipt is inconsistent');
  if (action === 'cleanup') {
    assert.equal(protections.temporaryGuard.enabled, false, 'Temporary guard was not released');
    assert.equal(protections.temporaryGuard.ownerTabId, null, 'Temporary guard owner was not cleared');
  } else {
    assert.equal(protections.temporaryGuard.enabled, true, 'Temporary guard is not active');
    assert.equal(protections.temporaryGuard.kind, 'render-preview', 'Unexpected temporary guard owner');
    if (tabId !== undefined) assert.equal(protections.temporaryGuard.ownerTabId, tabId,
      'Temporary guard belongs to another tab');
    assert.equal(protections.effectiveZeroTransport, true, 'No effective zero-transport protection');
  }
  return { ...receipt, protections };
}

const BODY_KEYS = new Set(['inputFrames', 'sourceText', 'originalText', 'inputText', 'translatedText',
  'text', 'body', 'contentText', 'author', 'authorName', 'authorId', 'uid', 'ruleValues']);
function containsBody(value) {
  return Array.isArray(value) ? value.some(containsBody)
    : value && typeof value === 'object' ? Object.entries(value).some(([key, item]) =>
      BODY_KEYS.has(key) && item !== undefined && item !== null &&
        !(key === 'inputFrames' && Number.isSafeInteger(item)) || containsBody(item)) : false;
}

export function assertRenderPreviewPage(receipt, expectedBuildId, expectedVersion,
  { action = 'status', expectedSessionHash, allowClosedTarget = false } = {}) {
  assert.equal(receipt?.ok, true, `Render-preview page ${action} was not accepted`);
  assert.equal(receipt.version, expectedVersion, 'Render-preview page version changed');
  assert.equal(receipt.buildId, expectedBuildId, 'Render-preview page build changed');
  assert.ok(receipt.session && typeof receipt.session === 'object', 'Render-preview page identity is missing');
  const closed = allowClosedTarget && receipt.closedTargetEvidence?.exists === false;
  if (expectedSessionHash && !closed) assert.equal(renderPreviewPageSessionHash(receipt.session), expectedSessionHash,
    'Render-preview page or video identity changed');
  if (closed) {
    assert.equal(receipt.report?.restored, true, 'Closed target restoration is unconfirmed');
    return receipt;
  }
  const report = receipt.report;
  assert.ok(report && typeof report === 'object', 'Render-preview report is missing');
  assert.equal(report.coverage?.mainBuildId, expectedBuildId, 'Coverage build changed');
  assert.equal(report.actualModelCalls, 0, 'Model call budget violated');
  assert.equal(report.modelLoads, 0, 'Model load budget violated');
  assert.equal(report.nativeSettingsWrites, 0, 'Native settings changed');
  assert.equal(report.adapterPrepared, 0, 'Real adapter received prepared translations');
  if (report.simulation) {
    assert.ok(report.simulation.B && typeof report.simulation.B === 'object', 'B-only simulation is missing');
    assert.equal(Object.hasOwn(report.simulation, 'A'), false, 'Render-preview must not create an A branch');
  }
  if (action === 'status' && containsBody(report))
    throw Error('Render-preview status contains input text or author data');
  if (action !== 'cleanup') {
    assert.ok(report.render && typeof report.render === 'object' && report.render.contract === 'render-preview-v1',
      'Render-preview engine report is missing');
    assert.ok(report.render.ui && report.render.ui.textInReport === false,
      'Render-preview UI text disclosure flag is invalid');
    assert.ok(Array.isArray(report.render.ui.activeDomPositions),
      'Current render-preview DOM positions are missing');
  }
  if (action === 'seek') assert.equal(report.playback?.seekCount, 1, 'Single seek was not confirmed');
  if (action === 'cleanup') assert.equal(report.restored, true, 'Page restoration is unconfirmed');
  return receipt;
}

function safeSimulationSummary(simulation) {
  if (!simulation) return null;
  const totals = simulation.B?.totals;
  const safeTotals = totals && Object.fromEntries(Object.entries(totals)
    .filter(([key, value]) => /^[a-zA-Z]+$/.test(key) && Number.isSafeInteger(value) && value >= 0));
  const branch = simulation.B ?? {};
  const counts = Object.fromEntries(['subscriptions', 'activeSubscriptions', 'submittedSubscriptions',
    'simulatedProviderCalls', 'simulatedProviderInputs', 'previewExcludedSubscriptions',
    'previewExcludedAfterSubmission', 'orphanInputs', 'lateResults'].map(key =>
    [key, Number.isSafeInteger(branch[key]) && branch[key] >= 0 ? branch[key] : null]));
  const project = (rows, keys) => (rows ?? []).map(row => Object.fromEntries(keys
    .filter(key => row[key] !== undefined).map(key => [key, row[key]])));
  return { evidence: simulation.evidence, stopped: simulation.stopped === true,
    stopReason: typeof simulation.stopReason === 'string' ? simulation.stopReason : '',
    resourceId: simulation.resourceId, epoch: simulation.epoch,
    inputFrameCount: Number.isSafeInteger(simulation.inputFrameCount) ? simulation.inputFrameCount : null,
    inputBytes: Number.isSafeInteger(simulation.inputBytes) ? simulation.inputBytes : null,
    inputTruncated: simulation.inputTruncated === true,
    B: { totals: safeTotals ?? {}, ...counts, truncated: branch.truncated === true,
      contextValid: branch.contextValid === true,
      events: project(branch.events, ['id', 'sourceId', 'resourceId', 'epoch', 'mediaTimeMs', 'state', 'unknown']),
      outcomes: project(branch.outcomes, ['key', 'id', 'epoch', 'state', 'mediaTimeMs', 'checkedAtMs',
        'result', 'submittedBeforeRevocation']) } };
}

/** Persist only the body-free render report and numeric B summary from an action receipt. */
export function projectRenderPreviewReceipt(receipt, action, observedAtMs) {
  const report = receipt.report ?? {};
  return { at: new Date(observedAtMs).toISOString(), observedAtMs, action,
    version: receipt.version, buildId: receipt.buildId,
    session: receipt.session ? { platform: receipt.session.platform, scenario: receipt.session.scenario,
      resourceId: receipt.session.resourceId, urlResourceId: receipt.session.urlResourceId ?? null,
      sessionId: receipt.session.sessionId, generation: receipt.session.generation } : null,
    background: receipt.background ? { version: receipt.background.version, buildId: receipt.background.buildId,
      idle: receipt.background.idle, zeroModelGuard: receipt.background.zeroModelGuard,
      actualModelCalls: receipt.background.actualModelCalls, blockedTransports: receipt.background.blockedTransports,
      protections: receipt.background.protections, cacheState: receipt.background.cacheState } : null,
    report: { coverage: report.coverage ? { mainBuildId: report.coverage.mainBuildId } : null,
      simulation: safeSimulationSummary(report.simulation), render: report.render ?? null,
      clock: report.clock ?? null, playback: report.playback ? { started: report.playback.started === true,
        restored: report.playback.restored === true, seekCount: report.playback.seekCount ?? null,
        owner: report.playback.owner ?? null, restoreDisposition: report.playback.restoreDisposition ?? null,
        playbackListeners: report.playback.playbackListeners ?? null } : null,
      restored: report.restored === true, actualModelCalls: report.actualModelCalls ?? 0,
      modelLoads: report.modelLoads ?? 0, nativeSettingsWrites: report.nativeSettingsWrites ?? 0,
      adapterPrepared: report.adapterPrepared ?? null } };
}

function assertStablePage(receipt, expectedBuildId, expectedVersion, expectedSessionHash, action = 'status') {
  return assertRenderPreviewPage(receipt, expectedBuildId, expectedVersion,
    { action, expectedSessionHash, allowClosedTarget: action === 'cleanup' });
}

function clockObservation(receipt, observedAtMs) {
  const clock = receipt.report?.clock;
  assert.ok(clock && typeof clock.resourceId === 'string' && clock.resourceId &&
    Number.isSafeInteger(clock.epoch) && clock.epoch >= 0 && Number.isFinite(clock.mediaTimeMs),
  'Render-preview media clock is missing');
  assert.equal(clock.resourceId, receipt.session.resourceId,
    'Render-preview media clock belongs to a different resource');
  return { observedAtMs, resourceId: clock.resourceId, epoch: clock.epoch,
    mediaTimeMs: clock.mediaTimeMs, paused: clock.paused, seeking: clock.seeking,
    contentActive: clock.contentActive, seekCount: receipt.report?.playback?.seekCount ?? null };
}

function assertRunningClock(point) {
  assert.equal(point.paused, false, 'Playback paused during the 35-second sample');
  assert.equal(point.seeking, false, 'Playback sought during the 35-second sample');
  assert.equal(point.contentActive, true, 'Video content ended or left the active render target');
  assert.equal(point.seekCount, 0, 'Unexpected seek occurred during the 35-second sample');
}

export function measureRenderPreviewWindow(observations) {
  assert.ok(Array.isArray(observations) && observations.length >= 10,
    'Render-preview sample has too few clock observations');
  const first = observations[0], last = observations.at(-1);
  const resourceId = first.resourceId, epoch = first.epoch;
  assert.ok(typeof resourceId === 'string' && resourceId && Number.isSafeInteger(epoch),
    'Render-preview sample identity is missing');
  for (const point of observations) {
    assertRunningClock(point);
    assert.equal(point.resourceId, resourceId, 'Render-preview sample crossed a resource boundary');
    assert.equal(point.epoch, epoch, 'Render-preview sample crossed a seek epoch');
    assert.ok(Number.isFinite(point.observedAtMs) && Number.isFinite(point.mediaTimeMs),
      'Render-preview sample clock value is invalid');
  }
  const wallDeltas = observations.slice(1).map((point, index) => point.observedAtMs - observations[index].observedAtMs);
  const mediaDeltas = observations.slice(1).map((point, index) => point.mediaTimeMs - observations[index].mediaTimeMs);
  assert.ok(wallDeltas.every(delta => delta >= 1500 && delta <= RENDER_PREVIEW_SAMPLE_INTERVAL_MS + 1500),
    'Render-preview sampling has an excessive observation gap');
  assert.ok(mediaDeltas.every(delta => delta >= 0), 'Render-preview media clock moved backwards');
  const wallDurationMs = last.observedAtMs - first.observedAtMs;
  const mediaDurationMs = last.mediaTimeMs - first.mediaTimeMs;
  assert.ok(wallDurationMs >= RENDER_PREVIEW_DURATION_MS - 500 && wallDurationMs <= RENDER_PREVIEW_DURATION_MS + 1500,
    `Observed ${wallDurationMs}ms of wall time; expected 35 seconds`);
  assert.ok(mediaDurationMs >= 30_000 && mediaDurationMs <= 40_000,
    `Media clock advanced ${mediaDurationMs}ms; expected roughly 35 seconds at 1x`);
  const rate = mediaDurationMs / wallDurationMs;
  assert.ok(rate >= 0.85 && rate <= 1.15, `Observed playback rate ${rate.toFixed(3)}x; expected 1x`);
  return { observationCount: observations.length, resourceId, epoch,
    wallStartMs: first.observedAtMs, wallEndMs: last.observedAtMs, wallDurationMs,
    mediaStartMs: first.mediaTimeMs, mediaEndMs: last.mediaTimeMs, mediaDurationMs,
    observedRate: rate, expectedRate: 1, pausedObservations: 0, seekingObservations: 0 };
}

function lastPositions(receipt) {
  const samples = receipt.report?.render?.ui?.activeDomPositions;
  assert.ok(Array.isArray(samples), 'Current render-preview DOM positions are missing');
  const byKey = new Map();
  for (const sample of samples) {
    assert.ok(sample && typeof sample.key === 'string' && sample.key &&
      [sample.xPx, sample.yPx, sample.widthPx, sample.heightPx, sample.mediaTimeMs].every(Number.isFinite),
    'Render-preview DOM geometry sample is invalid');
    byKey.set(sample.key, { key: sample.key, xPx: sample.xPx, yPx: sample.yPx,
      widthPx: sample.widthPx, heightPx: sample.heightPx, mediaTimeMs: sample.mediaTimeMs });
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function pausedPositionSnapshot(receipt, observedAtMs) {
  const point = clockObservation(receipt, observedAtMs);
  assert.equal(point.paused, true, 'Pause action was not confirmed');
  assert.equal(point.seeking, false, 'Video was seeking during the paused snapshots');
  return { observedAtMs, resourceId: point.resourceId, epoch: point.epoch,
    mediaTimeMs: point.mediaTimeMs, keys: lastPositions(receipt) };
}

export function assertPausedPositionsStable(first, second) {
  assert.equal(second.resourceId, first.resourceId, 'Resource changed between paused snapshots');
  assert.equal(second.epoch, first.epoch, 'Epoch changed between paused snapshots');
  assert.ok(Math.abs(second.mediaTimeMs - first.mediaTimeMs) <= 50,
    'Media position changed while paused');
  if (!first.keys.length || !second.keys.length) return { clockStable: true, positionsStable: null,
    positionEvidenceAvailable: false, keyCount: 0,
    mediaTimeMs: first.mediaTimeMs, secondMediaTimeMs: second.mediaTimeMs };
  assert.deepEqual(second.keys.map(item => item.key), first.keys.map(item => item.key),
    'Visible DOM sample keys changed while paused');
  for (let index = 0; index < first.keys.length; index++) {
    for (const key of ['xPx', 'yPx', 'widthPx', 'heightPx']) assert.ok(
      Math.abs(second.keys[index][key] - first.keys[index][key]) <= 1,
      `Paused DOM position changed for ${first.keys[index].key}`);
  }
  return { clockStable: true, positionsStable: true, positionEvidenceAvailable: true, keyCount: first.keys.length,
    mediaTimeMs: first.mediaTimeMs, secondMediaTimeMs: second.mediaTimeMs,
    maxPositionDeltaPx: 1 };
}

export async function prepareRenderPreview({ control, expected, checkpoint, refreshConnection,
  sleep = delay }) {
  const before = await control('rpc', { type: 'settings' });
  assert.equal(before.settings?.enabled, false, 'Saved translation must be disabled');
  const beforeHash = settingsHash(before.settings);
  let identity = await control('rpc', { type: 'build-identity' });
  assert.equal(identity.idle, true, 'Background is busy');
  if (identity.version !== expected.version || identity.buildId !== expected.buildId) {
    await checkpoint('reloading', { savedSettingsHash: beforeHash, expectedBuildId: expected.buildId });
    await control('reload');
    await sleep(500);
    await refreshConnection();
    identity = await control('rpc', { type: 'build-identity' });
    assert.equal(identity.idle, true, 'Reloaded background is busy');
  }
  assert.equal(identity.version, expected.version, 'Loaded background version mismatch');
  assert.equal(identity.buildId, expected.buildId, 'Loaded background build mismatch');
  const protections = protectionsOf(identity);
  assert.equal(protections.temporaryGuard.enabled, false,
    'An earlier render-preview guard must be cleaned up before a new run');
  const afterReload = await control('rpc', { type: 'settings' });
  assert.equal(afterReload.settings?.enabled, false, 'Saved translation must remain disabled');
  assert.equal(settingsHash(afterReload.settings), beforeHash, 'Settings changed during build reload');
  const prepared = await control('renderPreview', { action: 'prepare' });
  assertStablePage(prepared, expected.buildId, expected.version, null, 'prepare');
  assertRenderPreviewBackground(prepared.preparedBackground, expected.buildId, expected.version,
    { action: 'prepare', persistentGuard: protections.persistentGuard });
  assertRenderPreviewBackground(prepared.background, expected.buildId, expected.version,
    { action: 'status', tabId: prepared.preparedBackground.ownerTabId,
      persistentGuard: protections.persistentGuard });
  const cacheState = assertCacheState(prepared.preparedBackground.cacheState);
  const pageSessionHash = renderPreviewPageSessionHash(prepared.session);
  await checkpoint('prepared', { expectedBuildId: expected.buildId, expectedVersion: expected.version,
    sourceHash: expected.sourceHash, savedSettingsHash: beforeHash, pageSessionHash,
    persistentGuardBaseline: protections.persistentGuard, cacheStateBaseline: cacheState,
    ownedTargetTabId: prepared.preparedBackground.ownerTabId, reloadVerified: true, runIssued: false });
  return { prepared, savedSettingsHash: beforeHash, pageSessionHash,
    persistentGuardBaseline: protections.persistentGuard, cacheStateBaseline: cacheState };
}

async function status({ control, expectedBuildId, expectedVersion, expectedSessionHash, persistentGuardBaseline }) {
  const result = await control('renderPreview', { action: 'status' });
  assertStablePage(result, expectedBuildId, expectedVersion, expectedSessionHash, 'status');
  assertRenderPreviewBackground(result.background, expectedBuildId, expectedVersion,
    { action: 'status', persistentGuard: persistentGuardBaseline });
  return result;
}

export async function observeRenderPreview({ control, expectedBuildId, expectedVersion, expectedSessionHash,
  persistentGuardBaseline, sampleStartedAt, session, checkpoint, save, now = Date.now, sleep = delay,
  initialReceipt }) {
  const deadline = sampleStartedAt + RENDER_PREVIEW_DURATION_MS;
  const observations = session.clockObservations ?? [];
  if (initialReceipt && !observations.length) {
    const observedAtMs = session.runReceiptObservedAtMs ?? sampleStartedAt;
    assertStablePage(initialReceipt, expectedBuildId, expectedVersion, expectedSessionHash, 'run');
    assertRenderPreviewBackground(initialReceipt.background, expectedBuildId, expectedVersion,
      { action: 'status', persistentGuard: persistentGuardBaseline });
    const point = clockObservation(initialReceipt, observedAtMs);
    assertRunningClock(point);
    observations.push(point);
    session.clockObservations = observations;
    await checkpoint('sampling', { clockObservations: observations, sampleStartedAt, sampleDeadlineAt: deadline });
  }
  let nextAt = session.lastClockObservedAtMs ?? sampleStartedAt;
  if (nextAt <= sampleStartedAt) nextAt = sampleStartedAt + RENDER_PREVIEW_SAMPLE_INTERVAL_MS;
  else while (nextAt <= now()) nextAt += RENDER_PREVIEW_SAMPLE_INTERVAL_MS;
  let sample = observations.length - 1;
  while (now() < deadline) {
    const sampleAt = Math.min(nextAt, deadline);
    await sleep(Math.max(0, sampleAt - now()));
    const result = await status({ control, expectedBuildId, expectedVersion, expectedSessionHash,
      persistentGuardBaseline });
    const observedAtMs = now();
    const point = clockObservation(result, observedAtMs);
    assertRunningClock(point);
    sample++;
    observations.push(point);
    const evidencePath = await save(`status-${String(sample).padStart(2, '0')}`, projectRenderPreviewReceipt(result, 'status', observedAtMs));
    await checkpoint('sampling', { clockObservations: observations, lastClockObservedAtMs: observedAtMs,
      sampleCount: sample, lastStatusPath: evidencePath, sampleStartedAt, sampleDeadlineAt: deadline });
    if (sampleAt >= deadline || now() >= deadline) break;
    nextAt += RENDER_PREVIEW_SAMPLE_INTERVAL_MS;
  }
  const summary = measureRenderPreviewWindow(observations);
  const summaryPath = await save('clock-window', summary);
  await checkpoint('sample-window-elapsed', { clockObservations: observations, playbackWindow: summary,
    playbackWindowPath: summaryPath, sampleWindowComplete: true, lastClockObservedAtMs: now() });
  return { sampleCount: Math.max(0, sample), sampleDeadlineAt: deadline, playbackWindow: summary };
}

export async function runRenderPreview({ control, expectedBuildId, expectedVersion, expectedSessionHash,
  persistentGuardBaseline, session, checkpoint, save, now = Date.now, sleep = delay }) {
  assert.equal(session.runIssued, false, 'Render-preview run may only be issued once; use resume');
  await status({ control, expectedBuildId, expectedVersion, expectedSessionHash, persistentGuardBaseline });
  const sampleStartedAt = now();
  await checkpoint('run-issuing', { runIssued: true, sampleStartedAt,
    sampleDeadlineAt: sampleStartedAt + RENDER_PREVIEW_DURATION_MS });
  let started = await control('renderPreview', { action: 'run' });
  assertStablePage(started, expectedBuildId, expectedVersion, expectedSessionHash, 'run');
  assertRenderPreviewBackground(started.background, expectedBuildId, expectedVersion,
    { action: 'status', persistentGuard: persistentGuardBaseline });
  // The page posts one playback request; its acknowledgement arrives asynchronously.
  for (let attempt = 0; attempt < 60 &&
      (!started.report.playback?.started || started.report.clock?.paused !== false); attempt++) {
    await sleep(100);
    started = await status({ control, expectedBuildId, expectedVersion, expectedSessionHash, persistentGuardBaseline });
  }
  assert.equal(started.report.playback?.started, true, 'Playback start was not confirmed');
  assert.equal(started.report.clock?.paused, false, 'Playback start remained paused');
  assert.equal(started.report.playback?.seekCount, 0, 'Unexpected seek before sampling');
  const observedAtMs = now();
  const runReceiptPath = await save('run-started', projectRenderPreviewReceipt(started, 'run', observedAtMs));
  await checkpoint('sampling', { runIssued: true, sampleStartedAt: observedAtMs,
    runReceiptObservedAtMs: observedAtMs, sampleDeadlineAt: observedAtMs + RENDER_PREVIEW_DURATION_MS,
    runReceiptPath, clockObservations: [], lastClockObservedAtMs: observedAtMs });
  return observeRenderPreview({ control, expectedBuildId, expectedVersion, expectedSessionHash,
    persistentGuardBaseline, sampleStartedAt: observedAtMs, session, checkpoint, save, now, sleep,
    initialReceipt: started });
}

async function resumePause({ control, expectedBuildId, expectedVersion, expectedSessionHash,
  persistentGuardBaseline, session, checkpoint, save, now, sleep = delay }) {
  const recoveringPause = session.pauseIssued === true;
  if (!session.pauseIssued) {
    await checkpoint('pause-issuing', { pauseIssued: true, pauseConfirmed: false });
    const result = await control('renderPreview', { action: 'pause' });
    assertStablePage(result, expectedBuildId, expectedVersion, expectedSessionHash, 'pause');
    assertRenderPreviewBackground(result.background, expectedBuildId, expectedVersion,
      { action: 'status', persistentGuard: persistentGuardBaseline });
    assert.equal(result.report.clock?.paused, true, 'Pause action was not confirmed');
  } else if (!session.pauseConfirmed) {
    const result = await status({ control, expectedBuildId, expectedVersion, expectedSessionHash, persistentGuardBaseline });
    assert.equal(result.report.clock?.paused, true, 'Pause outcome is uncertain; refusing to issue pause again');
  }
  if (!session.pauseSnapshotOnePath) {
    // Let one render frame settle before measuring the current DOM nodes.
    await sleep(100);
    const result = await status({ control, expectedBuildId, expectedVersion, expectedSessionHash, persistentGuardBaseline });
    const snapshot = pausedPositionSnapshot(result, now());
    const path = await save('paused-position-1', projectRenderPreviewReceipt(result, 'status', snapshot.observedAtMs));
    await checkpoint('pause-confirmed', { pauseConfirmed: true, pauseSnapshotOne: snapshot,
      pauseSnapshotOnePath: path, pauseRecoveredByStatus: recoveringPause });
  } else if (!session.pauseConfirmed) {
    await checkpoint('pause-confirmed', { pauseConfirmed: true });
  }
  if (!session.pauseSnapshotTwoPath) {
    await sleep(750);
    const result = await status({ control, expectedBuildId, expectedVersion, expectedSessionHash, persistentGuardBaseline });
    const snapshot = pausedPositionSnapshot(result, now());
    const comparison = assertPausedPositionsStable(session.pauseSnapshotOne, snapshot);
    const path = await save('paused-position-2', projectRenderPreviewReceipt(result, 'status', snapshot.observedAtMs));
    const comparisonPath = await save('paused-position-comparison', comparison);
    await checkpoint('paused-stable', { pauseSnapshotTwo: snapshot, pauseSnapshotTwoPath: path,
      pauseComparisonPath: comparisonPath, pausedPositionsStable: comparison.positionsStable,
      pausePositionEvidenceAvailable: comparison.positionEvidenceAvailable,
      pausedPositionKeyCount: comparison.keyCount });
  }
}

async function resumePlay({ control, expectedBuildId, expectedVersion, expectedSessionHash,
  persistentGuardBaseline, session, checkpoint, save, now }) {
  if (!session.playIssued) {
    await checkpoint('play-issuing', { playIssued: true, playConfirmed: false });
    const result = await control('renderPreview', { action: 'play' });
    assertStablePage(result, expectedBuildId, expectedVersion, expectedSessionHash, 'play');
    assertRenderPreviewBackground(result.background, expectedBuildId, expectedVersion,
      { action: 'status', persistentGuard: persistentGuardBaseline });
    assert.equal(result.report.clock?.paused, false, 'Play action was not confirmed');
    const path = await save('play-confirmed', projectRenderPreviewReceipt(result, 'play', now()));
    await checkpoint('play-confirmed', { playConfirmed: true, playReceiptPath: path });
  } else if (!session.playConfirmed) {
    const result = await status({ control, expectedBuildId, expectedVersion, expectedSessionHash, persistentGuardBaseline });
    assert.equal(result.report.clock?.paused, false, 'Play outcome is uncertain; refusing to issue play again');
    const path = await save('play-recovered-status', projectRenderPreviewReceipt(result, 'status', now()));
    await checkpoint('play-confirmed', { playConfirmed: true, playReceiptPath: path, playRecoveredByStatus: true });
  }
}

async function resumeSeek({ control, expectedBuildId, expectedVersion, expectedSessionHash,
  persistentGuardBaseline, session, checkpoint, save, now }) {
  if (!session.seekIssued) {
    const before = await status({ control, expectedBuildId, expectedVersion, expectedSessionHash, persistentGuardBaseline });
    const fromEpoch = before.report.clock?.epoch;
    assert.ok(Number.isSafeInteger(fromEpoch), 'Seek baseline epoch is missing');
    await checkpoint('seek-issuing', { seekIssued: true, seekConfirmed: false, seekFromEpoch: fromEpoch });
    const result = await control('renderPreview', { action: 'seek' });
    assertStablePage(result, expectedBuildId, expectedVersion, expectedSessionHash, 'seek');
    assertRenderPreviewBackground(result.background, expectedBuildId, expectedVersion,
      { action: 'status', persistentGuard: persistentGuardBaseline });
    assert.equal(result.report.clock?.epoch === fromEpoch, false, 'Seek did not advance the playback epoch');
    assert.equal(result.report.clock?.seeking, false, 'Seek did not settle');
    assert.equal(result.report.playback?.seekCount, 1, 'Exactly one seek was not confirmed');
    const observedAtMs = now();
    const path = await save('seek-confirmed', projectRenderPreviewReceipt(result, 'seek', observedAtMs));
    await checkpoint('seek-confirmed', { seekConfirmed: true, seekReceiptPath: path,
      seekToEpoch: result.report.clock.epoch });
  } else if (!session.seekConfirmed) {
    const result = await status({ control, expectedBuildId, expectedVersion, expectedSessionHash, persistentGuardBaseline });
    assert.equal(result.report.playback?.seekCount, 1,
      'Seek outcome is uncertain; refusing to issue the seek again');
    assert.ok(Number.isSafeInteger(session.seekFromEpoch) && result.report.clock?.epoch !== session.seekFromEpoch,
      'Seek epoch change is unconfirmed');
    assert.equal(result.report.clock?.seeking, false, 'Seek is still in progress');
    const path = await save('seek-recovered-status', projectRenderPreviewReceipt(result, 'status', now()));
    await checkpoint('seek-confirmed', { seekConfirmed: true, seekReceiptPath: path,
      seekToEpoch: result.report.clock.epoch, seekRecoveredByStatus: true });
  }
}

export async function finishRenderPreview({ control, expectedBuildId, expectedVersion, expectedSessionHash,
  persistentGuardBaseline, session, checkpoint, save, read = readJSON, sleep = delay, now = Date.now,
  analyze = analyzeBilibiliRenderPreview }) {
  await resumePause({ control, expectedBuildId, expectedVersion, expectedSessionHash, persistentGuardBaseline,
    session, checkpoint, save, now, sleep });
  await resumePlay({ control, expectedBuildId, expectedVersion, expectedSessionHash, persistentGuardBaseline,
    session, checkpoint, save, now });
  await resumeSeek({ control, expectedBuildId, expectedVersion, expectedSessionHash, persistentGuardBaseline,
    session, checkpoint, save, now });

  if (!session.finalExportPath) {
    await checkpoint('exporting', { finalExportIssued: true });
    const exported = await control('renderPreview', { action: 'export' });
    assertStablePage(exported, expectedBuildId, expectedVersion, expectedSessionHash, 'export');
    assertRenderPreviewBackground(exported.background, expectedBuildId, expectedVersion,
      { action: 'status', persistentGuard: persistentGuardBaseline });
    assert.equal(exported.report.playback?.seekCount, 1, 'Final render export does not contain the single seek');
    const observedAtMs = now();
    const projected = projectRenderPreviewReceipt(exported, 'export', observedAtMs);
    const finalExportPath = await save('final-export', projected);
    const analysis = analyze(exported.report.render);
    assert.equal(analysis.ok, true, `Render-preview analysis failed: ${(analysis.violations ?? []).join(', ')}`);
    const analysisPath = await save('analysis', analysis);
    await checkpoint('analyzed', { finalExportPath, analysisPath, analysisOk: true,
      finalRecordCount: exported.report.render.records.length,
      finalEngineSampleCount: exported.report.render.samples.length,
      finalDomSampleCount: exported.report.render.ui.domSamples.length,
      finalAnalysisComplete: analysis.completeEvidence === true, seekIssued: true, seekConfirmed: true });
    return { export: projected, analysis, reused: false };
  }
  const projected = (await read(session.finalExportPath)).result;
  assert.equal(projected.buildId, expectedBuildId, 'Saved render-preview export build changed');
  assert.equal(projected.report.playback?.seekCount, 1, 'Saved render-preview export is missing the single seek');
  const analysis = session.analysisPath ? (await read(session.analysisPath)).result
    : analyze(projected.report.render);
  assert.equal(analysis.ok, true, `Saved render-preview analysis failed: ${(analysis.violations ?? []).join(', ')}`);
  if (!session.analysisPath) {
    const analysisPath = await save('analysis', analysis);
    await checkpoint('analyzed', { analysisPath, analysisOk: true,
      finalAnalysisComplete: analysis.completeEvidence === true, seekIssued: true, seekConfirmed: true });
  }
  return { export: projected, analysis, reused: true };
}

export async function resumeRenderPreview({ control, expectedBuildId, expectedVersion, expectedSessionHash,
  persistentGuardBaseline, cacheStateBaseline, session, checkpoint, save, read = readJSON,
  now = Date.now, sleep = delay }) {
  assert.equal(session.runIssued, true, 'No render-preview run to resume');
  if (!session.sampleWindowComplete) {
    const current = await status({ control, expectedBuildId, expectedVersion, expectedSessionHash, persistentGuardBaseline });
    if (now() < session.sampleStartedAt + RENDER_PREVIEW_DURATION_MS) {
      const point = clockObservation(current, now());
      assertRunningClock(point);
      session.clockObservations ??= [];
      if (!session.clockObservations.length || session.clockObservations.at(-1).observedAtMs !== point.observedAtMs)
        session.clockObservations.push(point);
      await save('resume-status', projectRenderPreviewReceipt(current, 'status', point.observedAtMs));
    }
    await observeRenderPreview({ control, expectedBuildId, expectedVersion, expectedSessionHash,
      persistentGuardBaseline, sampleStartedAt: session.sampleStartedAt, session, checkpoint, save, now, sleep });
  }
  if (session.phase === 'analyzed' && session.finalExportPath && session.analysisPath) {
    const current = await status({ control, expectedBuildId, expectedVersion, expectedSessionHash, persistentGuardBaseline });
    await save('resume-status', projectRenderPreviewReceipt(current, 'status', now()));
    const projected = (await read(session.finalExportPath)).result;
    const analysis = (await read(session.analysisPath)).result;
    assert.equal(projected.buildId, expectedBuildId);
    assert.equal(analysis.ok, true);
    return { resumed: true, complete: true, analysis };
  }
  const result = await finishRenderPreview({ control, expectedBuildId, expectedVersion, expectedSessionHash,
    persistentGuardBaseline, session, checkpoint, save, read, now });
  return { ...result, resumed: true };
}

export async function cleanupRenderPreview({ control, expectedBuildId, expectedVersion, expectedSessionHash,
  persistentGuardBaseline, cacheStateBaseline, savedSettingsHash, session, checkpoint, save, read = readJSON }) {
  let restored;
  if (session.guardReleased) {
    assert.ok(session.cleanupReceiptPath, 'Released-guard checkpoint is missing its receipt');
    restored = (await read(session.cleanupReceiptPath)).result;
    assert.equal(restored.report?.restored, true, 'Saved page restoration is unconfirmed');
    assert.equal(restored.background?.protections?.temporaryGuard?.enabled, false,
      'Saved temporary-guard release is unconfirmed');
    assert.deepEqual(restored.background?.protections?.persistentGuard, persistentGuardBaseline,
      'Saved persistent guard summary changed');
  } else {
    await checkpoint('restoring-page', { cleanupIssued: true });
    restored = await control('renderPreview', { action: 'cleanup' });
    assertStablePage(restored, expectedBuildId, expectedVersion, expectedSessionHash, 'cleanup');
    assertRenderPreviewBackground(restored.background, expectedBuildId, expectedVersion,
      { action: 'cleanup', persistentGuard: persistentGuardBaseline });
    assert.equal(restored.guardReleased, true, 'Background render-preview guard release is unconfirmed');
    if (!Number.isSafeInteger(session.ownedTargetTabId)) {
      assert.ok(Number.isSafeInteger(restored.ownedTargetTabId), 'Prepared target ownership is unavailable');
      await checkpoint('restoring-page', { ownedTargetTabId: restored.ownedTargetTabId });
    }
    if (restored.report.simulation) assert.equal(restored.report.simulation.B.activeSubscriptions, 0,
      'Preview simulation subscriptions remain active');
    if (restored.report.render) {
      const ui = restored.report.render.ui;
      for (const key of ['activeNodes', 'measurementNodes', 'visibilityListenerCount',
        'detailsListenerCount', 'fontListenerCount', 'motionListenerCount'])
        assert.equal(ui[key], 0, `Preview ${key} remains after cleanup`);
      for (const key of ['enabled', 'rafActive', 'intersectionActive', 'resizeActive'])
        assert.equal(ui[key], false, `Preview ${key} remains after cleanup`);
      assert.deepEqual(ui.activeDomPositions, [], 'Preview DOM positions remain after cleanup');
      assert.ok(restored.report.render.records.every(row => !['reserved', 'unallocated', 'committed'].includes(row.state)),
        'Preview reservations remain after cleanup');
    }
    const cleanupCacheState = assertCacheState(restored.background.cacheState);
    let cacheUnchanged = null;
    if (cacheStateBaseline?.available && cleanupCacheState.available) {
      assert.deepEqual(cleanupCacheState, cacheStateBaseline,
        'Read-only cache entry count or metadata summary changed');
      cacheUnchanged = true;
    }
    const cleanupReceiptPath = await save('restored-and-guard-released',
      { ...projectRenderPreviewReceipt(restored, 'cleanup', Date.now()), cleanupCacheState,
        cacheUnchanged, persistentGuardUnchanged: true });
    await checkpoint('guard-released', { restored: true, guardReleased: true, cleanupReceiptPath,
      cleanupCacheState, cacheUnchanged, persistentGuardUnchanged: true });
  }

  let closed;
  if (session.ownedTargetClosed) {
    assert.ok(session.closedReceiptPath, 'Closed-target checkpoint is missing its receipt');
    closed = (await read(session.closedReceiptPath)).result;
  } else {
    if (!session.closeAttempted) await checkpoint('closing-owned-target', { closeAttempted: true });
    closed = await control('close-render-preview-owned');
    assert.equal(closed.closed, true, 'Render-preview owned target closure or prior absence is unconfirmed');
    assert.equal(closed.tabId, session.ownedTargetTabId, 'Runner attempted to close a different target tab');
    const closedReceiptPath = await save('closed-owned', closed);
    await checkpoint('owned-target-closed', { ownedTargetClosed: true, closedReceiptPath,
      targetAlreadyAbsent: closed.closed === false });
  }
  const after = await control('rpc', { type: 'settings' });
  const settingsUnchanged = savedSettingsHash ? settingsHash(after.settings) === savedSettingsHash : null;
  if (savedSettingsHash) assert.equal(settingsUnchanged, true, 'Saved settings changed during render-preview verification');
  await save('settings-check', { savedSettingsUnchanged: settingsUnchanged, savedSettingsHash: savedSettingsHash ?? null });
  const cleanupCacheUnchanged = session.cleanupCacheState?.available === true && cacheStateBaseline?.available === true
    ? JSON.stringify(session.cleanupCacheState) === JSON.stringify(cacheStateBaseline) : null;
  await checkpoint('cleaned', { restored: true, guardReleased: true, ownedTargetClosed: true,
    savedSettingsUnchanged: settingsUnchanged, cacheUnchanged: cleanupCacheUnchanged,
    persistentGuardUnchanged: session.persistentGuardUnchanged === true });
  return { restored, closed, savedSettingsUnchanged: settingsUnchanged,
    cacheUnchanged: cleanupCacheUnchanged, persistentGuardUnchanged: session.persistentGuardUnchanged === true };
}

async function acquireSharedRunnerLock() {
  await mkdir(dirname(LOCK_PATH), { recursive: true });
  try { return await open(LOCK_PATH, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = await readJSON(LOCK_PATH);
    assert.ok(Number.isSafeInteger(prior.pid) && prior.pid > 0, 'Unrecognized runner lock');
    try { process.kill(prior.pid, 0); throw Error(`Runner process ${prior.pid} still exists`); }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
    await unlink(LOCK_PATH);
    return open(LOCK_PATH, 'wx');
  }
}

async function ensureBuild(session) {
  let deployed = await optional(resolve(EXTENSION, 'runtime-identity.json'));
  if (!deployed || deployed.sourceHash !== createBuildIdentity(ROOT).sourceHash) {
    await writeSession(session, 'building');
    const log = await open(resolve(session.folder, 'build.log'), 'a');
    try {
      await new Promise((yes, no) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
          resolve(WORKSPACE, 'tools/Update-TestBuild.ps1')],
        { cwd: ROOT, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
        child.on('error', no);
        child.on('exit', code => code === 0 ? yes() : no(Error(`Updater failed (${code}); see build.log`)));
      });
    } finally { await log.close(); }
    deployed = await readJSON(resolve(EXTENSION, 'runtime-identity.json'));
  }
  assert.equal(deployed.sourceHash, createBuildIdentity(ROOT).sourceHash, 'Source changed during build');
  return deployed;
}

async function createRenderPreviewSession() {
  return createSession(RENDER_PREVIEW_ARTIFACT_ROOT, ROUND);
}

async function main(command) {
  if (command === 'help') {
    console.log('Usage: node scripts/verify-bilibili-render-preview.mjs prepare|run|resume|cleanup');
    return;
  }
  assert.ok(['prepare', 'run', 'resume', 'cleanup'].includes(command), 'Unknown render-preview runner action');
  const prior = await loadSession(RENDER_PREVIEW_ARTIFACT_ROOT, ROUND);
  if (command === 'cleanup' && (!prior || prior.phase === 'cleaned')) {
    console.log(JSON.stringify({ phase: prior?.phase ?? 'no-session', directory: prior?.folder ?? null }));
    return;
  }
  await mkdir(RENDER_PREVIEW_ARTIFACT_ROOT, { recursive: true });
  const lock = await acquireSharedRunnerLock();
  const transport = createBilibiliRunnerTransport();
  let session;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    session = prior;
    if (command === 'resume' && !session) throw Error('No render-preview run to resume');
    if (command === 'resume' && session.phase === 'cleaned') throw Error('Render-preview session is already cleaned');
    if (command !== 'cleanup' && (!session || session.phase === 'cleaned')) session = await createRenderPreviewSession();
    if (command === 'run' && session.runIssued) throw Error('Run already issued; use resume to continue without replay');
    if (command === 'resume' && session.sampleInvalid) throw Error('RENDER_PREVIEW_SAMPLE_INVALID_CLEANUP_REQUIRED');

    let expected = null;
    if (command === 'prepare' || command === 'run' && !session.runIssued) {
      expected = session.expectedBuildId && session.savedSettingsHash && session.pageSessionHash
        ? { buildId: session.expectedBuildId, version: session.expectedVersion, sourceHash: session.sourceHash }
        : await ensureBuild(session);
    }
    await transport.connect();
    const control = (...args) => transport.control(...args);
    const checkpoint = (phase, extra) => writeSession(session, phase, extra);
    const save = async (name, result) => {
      const path = resolve(session.folder, `${String(session.seq).padStart(4, '0')}-${name}-${randomUUID().slice(0, 8)}.json`);
      await writeJSON(path, { at: new Date().toISOString(), result });
      return path;
    };

    if (command === 'prepare' || command === 'run' && !session.runIssued) {
      if (session.pageSessionHash) {
        const settings = await control('rpc', { type: 'settings' });
        assert.equal(settingsHash(settings.settings), session.savedSettingsHash,
          'Saved settings changed after render-preview preparation');
        const current = await status({ control, expectedBuildId: session.expectedBuildId,
          expectedVersion: session.expectedVersion, expectedSessionHash: session.pageSessionHash,
          persistentGuardBaseline: session.persistentGuardBaseline });
        await save('reused-session-status', projectRenderPreviewReceipt(current, 'status', Date.now()));
      } else {
        expected = expected ?? await ensureBuild(session);
        const prepared = await prepareRenderPreview({ control, expected, checkpoint,
          refreshConnection: async () => { transport.openPage(); await transport.waitHello(30000); } });
        Object.assign(session, { expectedBuildId: expected.buildId, expectedVersion: expected.version,
          sourceHash: expected.sourceHash, savedSettingsHash: prepared.savedSettingsHash,
          pageSessionHash: prepared.pageSessionHash,
          persistentGuardBaseline: prepared.persistentGuardBaseline, cacheStateBaseline: prepared.cacheStateBaseline,
          ownedTargetTabId: prepared.prepared.preparedBackground.ownerTabId, reloadVerified: true });
        await save('prepared', projectRenderPreviewReceipt(prepared.prepared, 'prepare', Date.now()));
      }
      if (command === 'prepare') return;
    }

    if (command === 'run') {
      assert.ok(session.expectedBuildId && session.pageSessionHash && session.savedSettingsHash,
        'Prepare the render-preview session first');
      const before = await control('rpc', { type: 'settings' });
      assert.equal(settingsHash(before.settings), session.savedSettingsHash, 'Saved settings changed after preparation');
      await runRenderPreview({ control, expectedBuildId: session.expectedBuildId,
        expectedVersion: session.expectedVersion, expectedSessionHash: session.pageSessionHash,
        persistentGuardBaseline: session.persistentGuardBaseline, session, checkpoint, save });
      await finishRenderPreview({ control, expectedBuildId: session.expectedBuildId,
        expectedVersion: session.expectedVersion, expectedSessionHash: session.pageSessionHash,
        persistentGuardBaseline: session.persistentGuardBaseline, session, checkpoint, save });
    } else if (command === 'resume') {
      assert.ok(session.expectedBuildId && session.expectedVersion && session.pageSessionHash &&
        session.savedSettingsHash && session.persistentGuardBaseline, 'Render-preview run has no verified preparation');
      const before = await control('rpc', { type: 'settings' });
      assert.equal(settingsHash(before.settings), session.savedSettingsHash, 'Saved settings changed after preparation');
      await resumeRenderPreview({ control, expectedBuildId: session.expectedBuildId,
        expectedVersion: session.expectedVersion, expectedSessionHash: session.pageSessionHash,
        persistentGuardBaseline: session.persistentGuardBaseline, cacheStateBaseline: session.cacheStateBaseline,
        session, checkpoint, save });
    } else if (command === 'cleanup') {
      assert.ok(session, 'No render-preview session to clean up');
      const identity = await control('rpc', { type: 'build-identity' });
      await cleanupRenderPreview({ control, expectedBuildId: session.pageSessionHash ? session.expectedBuildId : identity.buildId,
        expectedVersion: session.pageSessionHash ? session.expectedVersion : identity.version,
        expectedSessionHash: session.pageSessionHash,
        persistentGuardBaseline: session.persistentGuardBaseline ?? protectionsOf(identity).persistentGuard,
        cacheStateBaseline: session.cacheStateBaseline, savedSettingsHash: session.savedSettingsHash,
        checkpoint, save, session });
    }
  } catch (error) {
    const message = transport.redact(error instanceof Error ? error.message : String(error));
    if (session) await writeSession(session, 'attention-required', { error: message, resumePhase: session.phase });
    else console.error(message);
    process.exitCode = 1;
  } finally {
    await transport.close();
    await lock.close();
    await unlink(LOCK_PATH);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv[2] ?? 'help');
