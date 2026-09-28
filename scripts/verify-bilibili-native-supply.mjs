// Fixed-video native adoption runner. Import and help never launch the browser or a model.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, loadSession, writeSession } from './verify-bilibili-user-filters.mjs';
import { createBuildIdentity } from './build-identity.mjs';
import { writeJSON } from './bilibili-dispatch-ledger.mjs';
import { createBilibiliRunnerTransport } from './bilibili-runner-transport.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = resolve(ROOT, '../DanLingo-Workspace/testing/current/extension');
export const NATIVE_SUPPLY_ARTIFACT_ROOT = resolve(ROOT, '.artifacts/bilibili-native-supply/v1');
export const NATIVE_SUPPLY_RESOURCE = 'av117318021548752:cid42173138507';
export const NATIVE_SUPPLY_LIMIT = Object.freeze({ requests: 100, items: 100, utf16Chars: 2000 });
const LOCK_PATH = resolve(NATIVE_SUPPLY_ARTIFACT_ROOT, 'runner.lock');
const ROUND = 'v1';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const settingsHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sessionHash = value => settingsHash({ platform: value.platform, scenario: value.scenario,
  resourceId: value.resourceId, urlResourceId: value.urlResourceId ?? null, sessionId: value.sessionId });

export function parseNativeSupplyArgs(argv) {
  const [command = 'help', ...rest] = argv;
  assert.ok(['help', 'reference', 'reference-full', 'reference-official', 'reference-official-remaining', 'reference-official-dom', 'prepare', 'recover-prepare', 'run', 'replay', 'status', 'cleanup'].includes(command), 'Unknown native-supply action');
  if (command !== 'prepare') { assert.equal(rest.length, 0, 'Unexpected arguments'); return { command }; }
  const entries = new Map();
  assert.equal(rest.length % 2, 0, 'Options require values');
  for (let i = 0; i < rest.length; i += 2) {
    assert.ok(['--model-id', '--phase', '--reason', '--from-ms', '--to-ms', '--extra-model-load'].includes(rest[i]) &&
      !entries.has(rest[i]) && rest[i + 1], 'Invalid prepare option');
    entries.set(rest[i], rest[i + 1]);
  }
  const modelId = entries.get('--model-id');
  assert.match(modelId ?? '', /^[a-zA-Z0-9_-]{1,200}$/, 'Registered model ID required');
  const phase = entries.get('--phase') ?? 'main';
  assert.ok(['main', 'repair'].includes(phase));
  if (phase === 'main') {
    assert.deepEqual([...entries.keys()].sort(), ['--model-id']);
    return { command, modelId, phase, fromMs: 0, toMs: 45_000 };
  }
  const authorizedExtraLoad = entries.has('--extra-model-load');
  if (authorizedExtraLoad) assert.equal(entries.get('--extra-model-load'), '1', 'Only one additional load may be authorized');
  assert.deepEqual([...entries.keys()].sort(), [...(authorizedExtraLoad ? ['--extra-model-load'] : []),
    '--from-ms', '--model-id', '--phase', '--reason', '--to-ms']);
  const fromMs = Number(entries.get('--from-ms')), toMs = Number(entries.get('--to-ms'));
  assert.ok(Number.isSafeInteger(fromMs) && Number.isSafeInteger(toMs) && fromMs >= 0 &&
    toMs <= 45_000 && toMs > fromMs && toMs - fromMs <= 15_000, 'Repair must last at most 15s within 0-45s');
  const repairReason = entries.get('--reason');
  assert.ok(repairReason?.trim() && repairReason.length <= 500, 'Repair reason required');
  return { command, modelId, phase, fromMs, toMs, repairReason,
    ...(authorizedExtraLoad ? { authorizedExtraLoad: true } : {}) };
}

export function assertRepairContinuation(prior, args) {
  assert.ok(prior?.phaseName === 'main' && prior.taskId && prior.runIssued &&
    !prior.repairUsed && !prior.replayIssued && prior.modelId === args.modelId &&
    (args.authorizedExtraLoad === true ? prior.phase === 'cleaned' && prior.cleanupConfirmed === true &&
      prior.resumePhase === 'start-issuing' && typeof prior.error === 'string' && !!prior.error &&
      typeof prior.savedSettingsHash === 'string' : prior.phase === 'cold-complete'),
  'Repair requires the same task and an unused repair; extra load requires explicitly authorized cleaned failure');
}

export function assertNativeBudget(host, baseline = null) {
  assert.equal(host?.ok, true, 'Native-supply host unavailable');
  assert.equal(host.onlineCalls, 0, 'Online transport used');
  const total = host.budget?.total;
  assert.ok(total && total.limits && total.occupied && total.actualSent, 'Durable total budget missing');
  for (const key of Object.keys(NATIVE_SUPPLY_LIMIT)) {
    assert.equal(total.limits[key], NATIVE_SUPPLY_LIMIT[key], `Unexpected ${key} cap`);
    assert.ok(Number.isSafeInteger(total.occupied[key]) && total.occupied[key] >= 0 &&
      total.occupied[key] <= NATIVE_SUPPLY_LIMIT[key], `${key} occupied cap exceeded`);
    assert.ok(Number.isSafeInteger(total.actualSent[key]) && total.actualSent[key] >= 0 &&
      total.actualSent[key] <= total.occupied[key], `${key} actual sends exceed occupied budget`);
    if (baseline) {
      assert.equal(total.occupied[key], baseline.occupied[key], `Cache-only replay reserved ${key}`);
      assert.equal(total.actualSent[key], baseline.actualSent[key], `Cache-only replay sent ${key}`);
    }
  }
  return structuredClone(total);
}
export function assertNativePage(reply, expected, { epoch, session, prepareAt } = {}) {
  assert.equal(reply?.ok, true, 'Native-supply page unavailable');
  assert.equal(reply.buildId, expected.buildId, 'Page build mismatch');
  assert.equal(reply.session?.resourceId, NATIVE_SUPPLY_RESOURCE, 'Wrong video/CID');
  assert.equal(reply.session?.platform, 'bilibili');
  assert.equal(reply.session?.scenario, 'video');
  assert.ok(reply.session.sessionId, 'Document session missing');
  assert.ok(Number.isSafeInteger(reply.epoch) && reply.epoch >= 0, 'Playback epoch missing');
  assert.ok(Number.isFinite(reply.clock?.mediaTimeMs), 'Media clock missing');
  if (epoch !== undefined) assert.equal(reply.epoch, epoch, 'Playback epoch changed');
  if (session) assert.equal(sessionHash(reply.session), session, 'Document session changed');
  if (prepareAt !== undefined) {
    assert.equal(reply.clock.paused, true, 'Preparation must remain paused');
    assert.equal(reply.clock.seeking, false, 'Preparation seek incomplete');
    assert.ok(Math.abs(reply.clock.mediaTimeMs - prepareAt) < 300, 'Preparation position changed');
  }
  return reply;
}
function assertNativeOwner(reply, expected, session, state) {
  assertNativePage(reply, expected, { epoch: session.epoch, session: session.pageSessionHash });
  assert.equal(reply.host?.buildId, expected.buildId, 'Host build mismatch');
  assert.equal(reply.host?.grant?.taskId, session.taskId);
  assert.equal(reply.host?.grant?.runId, session.runId);
  assert.equal(reply.host?.grant?.tabId, session.ownedTargetTabId);
  assert.equal(reply.host?.grant?.instanceId, session.instanceId);
  assert.equal(reply.host?.grant?.epoch, session.epoch);
  if (state) assert.equal(reply.host.grant.state, state);
  assertNativeBudget(reply.host, session.cacheOnly ? session.coldBudget : null);
  return reply;
}
export function nativeSupplySummary(page, host) {
  const events = Array.isArray(page.events) ? page.events : [];
  const counts = Object.fromEntries([...new Set(events.map(row => row.type))].map(type =>
    [type, events.filter(row => row.type === type).length]));
  return { eventTypes: counts, state: page.state, epoch: page.epoch,
    admissions: counts.nativeAdmissionOpportunity ?? 0, direct: counts.adopted ?? 0,
    suppressed: counts.suppressed ?? 0, firstShow: counts.nativeFirstShow ?? 0,
    domSamples: counts.domSample ?? 0,
    actualSent: host.budget?.total?.actualSent ?? null,
    occupied: host.budget?.total?.occupied ?? null,
    cacheOnly: host.nativeSupply?.cacheOnly === true,
    replacement: host.nativeSupply?.replacement ?? 'unavailable' };
}

/** Native playback with Shadow and an independent zero-transport guard; never opens a model permit. */
export async function runNativeReference({ control, expected, save, sleep = delay }) {
  const identity = await control('rpc', { type: 'build-identity' });
  const settings = await control('rpc', { type: 'settings' });
  assert.equal(identity.buildId, expected.buildId);
  assert.equal(identity.version, expected.version);
  assert.equal(identity.idle, true, 'Background must be idle');
  assert.equal(settings.settings?.enabled, false, 'Saved translation must be disabled');
  assert.equal(settings.settings?.bilibiliNativeTranslationOnly, false, 'Strict mode must be off for reference');
  let owned = false, completed = false;
  try {
    const start = await control('nativeSupply', { action: 'reference-start' }, 45_000);
    owned = true;
    assertNativePage(start, expected);
    assert.equal(start.background?.protections?.effectiveZeroTransport, true, 'Reference transport guard missing');
    assert.equal(start.background?.actualModelCalls, 0);
    await save('reference-start', start);
    let last = start;
    const observations = [];
    const end = Date.now() + 85_000;
    for (let sample = 0; sample < 44; sample++) {
      await sleep(2000);
      last = assertNativePage(await control('nativeSupply', { action: 'reference-status' }), expected,
        { epoch: start.epoch, session: sessionHash(start.session) });
      assert.equal(last.background?.protections?.effectiveZeroTransport, true);
      assert.equal(last.background?.actualModelCalls, 0);
      observations.push({ at: new Date().toISOString(), clock: last.clock, epoch: last.epoch });
      if (last.clock.mediaTimeMs >= 52_000 && last.clock.paused === true) break;
      if (Date.now() > end) throw Error('Native reference did not reach the 52-second tail');
    }
    await save('reference-clocks', observations);
    assert.ok(last.clock.mediaTimeMs >= 52_000 && last.clock.paused === true,
      'Reference 0–45s plus 7s tail was not observed');
    const stopped = assertNativePage(await control('nativeSupply', { action: 'reference-stop' }), expected,
      { epoch: start.epoch, session: sessionHash(start.session) });
    assert.equal(stopped.clock.paused, true);
    const exported = assertNativePage(await control('nativeSupply', { action: 'reference-export' }), expected,
      { epoch: start.epoch, session: sessionHash(start.session) });
    await save('reference-export', exported);
    const report = exported.shadow;
    const nativeEvents = report?.ledger?.events ?? [];
    const inWindow = nativeEvents.filter(row => row?.type === 'nativeInitRender' &&
      row.stimeMs >= 0 && row.stimeMs < 45_000);
    const summary = { buildId: expected.buildId, version: expected.version,
      resourceId: exported.session.resourceId, epoch: exported.epoch,
      observation: 'native Shadow lifecycle, not visible-pixel proof',
      zeroModelCalls: exported.background?.actualModelCalls === 0,
      nativeInitRender0to45: inWindow.length,
      nativeInitRender0to5: inWindow.filter(row => row.stimeMs < 5000).length,
      nativeInitRender5to10: inWindow.filter(row => row.stimeMs >= 5000 && row.stimeMs < 10000).length,
      nativeInitRender10to45: inWindow.filter(row => row.stimeMs >= 10000).length,
      shadowSelected: report?.ledger?.classification?.eventTypes?.shadowSelected ?? null,
      shadowKnown: report?.known === true, instrumentationErrors: report?.observed?.instrumentationErrors ?? null,
      finalClock: exported.clock };
    await save('reference-summary', summary);
    assert.equal(exported.background?.actualModelCalls, 0);
    assert.equal(report?.known, true, 'Shadow contract did not establish a known prediction state');
    assert.equal(summary.instrumentationErrors, 0, 'Native reference instrumentation failed');
    assert.ok(summary.nativeInitRender0to45 > 0, 'No native render admission in reference window');
    completed = true;
    return { exported, summary };
  } finally {
    // A lost start reply may still own the tab and guard. Cleanup is deliberately
    // available after either a successful run or a recoverable partial start.
    if (owned) {
      const cleanup = await control('nativeSupply', { action: 'reference-cleanup' });
      assert.equal(cleanup.guardReleased, true);
      assert.equal(cleanup.closed, true);
      await save('reference-cleanup', cleanup);
    } else if (!completed) {
      await save('reference-start-unconfirmed', { note: 'Check reference owner before retry if start timed out' });
    }
  }
}

function fullReferenceReply(reply, expected, start = null) {
  assertNativePage(reply, expected, start ? { epoch: start.epoch, session: sessionHash(start.session) } : {});
  assert.equal(reply.background?.protections?.effectiveZeroTransport, true, 'Reference transport guard missing');
  assert.equal(reply.background?.actualModelCalls, 0, 'Reference issued a model call');
  assert.equal(reply.reference?.fullVideo, true, 'Full-video reference missing');
  assert.ok(Number.isFinite(reply.reference.durationMs) && reply.reference.durationMs > 0 &&
    reply.reference.durationMs <= 3_600_000, 'Video duration unavailable or exceeds one hour');
  assert.equal(typeof reply.reference.ended, 'boolean', 'Playback end state unavailable');
  if (start) assert.equal(reply.reference.durationMs, start.reference.durationMs, 'Video duration changed');
  return reply;
}

function fullReferenceDelta(page, offsets) {
  const reference = page.reference;
  assert.ok(Array.isArray(reference.samples) && Array.isArray(reference.forecasts), 'Full reference samples missing');
  const shadowEvents = page.shadow?.ledger?.events ?? [];
  const nativeEvents = page.events ?? [];
  assert.ok(Array.isArray(shadowEvents) && Array.isArray(nativeEvents), 'Reference event ledger invalid');
  const sources = { samples: reference.samples, forecasts: reference.forecasts,
    shadowEvents, nativeEvents };
  const delta = {};
  for (const [key, values] of Object.entries(sources)) {
    assert.ok(values.length >= offsets[key], `Reference ${key} ledger reset`);
    delta[key] = values.slice(offsets[key]); offsets[key] = values.length;
  }
  return { clock: page.clock, epoch: page.epoch,
    reference: { durationMs: reference.durationMs, ended: reference.ended,
      startedAtEpochMs: reference.startedAtEpochMs,
      truncated: reference.truncated, sampleCount: reference.sampleCount,
      forecastCount: reference.forecastCount },
    shadow: { known: page.shadow?.known ?? null, observed: page.shadow?.observed ?? null,
      classification: page.shadow?.ledger?.classification ?? null }, ...delta };
}

function fullReferenceInterruptions(samples) {
  const result = { paused: 0, hidden: 0, seeking: 0, rateChanged: 0,
    firstInterruptedAtEpochMs: null, lastInterruptedAtEpochMs: null };
  for (const row of samples) {
    if (row.ended) continue;
    if (row.paused) result.paused++;
    if (row.visible === false) result.hidden++;
    if (row.seeking) result.seeking++;
    if (Number.isFinite(row.playbackRate) && row.playbackRate !== 1) result.rateChanged++;
    if (row.paused || row.visible === false || row.seeking || row.playbackRate !== 1) {
      result.firstInterruptedAtEpochMs ??= row.atEpochMs;
      result.lastInterruptedAtEpochMs = row.atEpochMs;
    }
  }
  return result;
}

/** Observe natural playback through the end. Snapshots export Shadow without pausing the page. */
export async function runFullNativeReference({ control, expected, save, sleep = delay,
  now = Date.now }) {
  const identity = await control('rpc', { type: 'build-identity' });
  const settings = await control('rpc', { type: 'settings' });
  const localBeforeReply = await control('rpc', { type: 'local-control', control: { action: 'state' } });
  assert.equal(identity.buildId, expected.buildId);
  assert.equal(identity.version, expected.version);
  assert.equal(identity.idle, true, 'Background must be idle');
  assert.equal(settings.settings?.enabled, false, 'Saved translation must be disabled');
  assert.equal(settings.settings?.bilibiliNativeTranslationOnly, false, 'Strict mode must be off');
  assert.equal(localBeforeReply?.ok, true, 'Local state unavailable');
  const localBefore = localBeforeReply.state;
  assert.ok(['idle', 'ready'].includes(localBefore?.phase) && localBefore.active === 0 &&
    localBefore.queued === 0 && Number.isSafeInteger(localBefore.generation) &&
    Number.isSafeInteger(localBefore.inferenceCalls), 'Local runtime must be idle or ready without work');
  const savedSettingsHash = settingsHash(settings.settings);
  await save('reference-full-before', { build: identity, settingsHash: savedSettingsHash,
    local: { phase: localBefore.phase, generation: localBefore.generation,
      inferenceCalls: localBefore.inferenceCalls, modelId: localBefore.model?.id ?? null } });
  let startIssued = false, owned = false, completed = false, last = null, failure = null;
  try {
    startIssued = true;
    const start = fullReferenceReply(await control('nativeSupply', { action: 'reference-full-start' }, 45_000), expected);
    owned = true; last = start;
    await save('reference-full-start', start);
    const deadline = now() + start.reference.durationMs + 60_000;
    const maxSamples = Math.ceil((start.reference.durationMs + 60_000) / 2000) + 1;
    const offsets = { samples: 0, forecasts: 0, shadowEvents: 0, nativeEvents: 0 };
    let lastProgressAt = now(), lastMediaMs = start.clock.mediaTimeMs;
    for (let sample = 1; !last.reference.ended; sample++) {
      if (sample > maxSamples || now() > deadline) throw Error('Full reference exceeded video duration plus 60 seconds');
      await sleep(2000);
      const snapshot = await control('nativeSupply', { action: 'reference-snapshot' });
      const delta = fullReferenceDelta(snapshot, offsets);
      await save(`reference-full-snapshot-${String(sample).padStart(4, '0')}`, delta);
      last = fullReferenceReply(snapshot, expected, start);
      assert.equal(last.reference.truncated, false, 'Full reference ledger truncated');
      assert.notEqual(last.shadow?.ledger?.truncated, true, 'Shadow ledger truncated');
      assert.notEqual(last.shadow?.capacityExceeded, true, 'Shadow source capacity exceeded');
      if (last.clock.mediaTimeMs > lastMediaMs + 100) {
        lastProgressAt = now(); lastMediaMs = last.clock.mediaTimeMs;
      }
      if (!last.reference.ended && now() - lastProgressAt >= 12_000)
        throw Error('Full reference playback stopped for at least 12 seconds');
    }
    // The final non-pausing snapshot is the complete export; no artificial tail is played.
    const exported = fullReferenceReply(last, expected, start);
    assert.equal(exported.reference.ended, true);
    await save('reference-full-export', exported);
    const samples = exported.reference.samples;
    const forecasts = exported.reference.forecasts;
    const startedAtEpochMs = exported.reference.startedAtEpochMs;
    assert.ok(Number.isFinite(startedAtEpochMs) && startedAtEpochMs > 0,
      'Reference playback start timestamp unavailable');
    const playbackSamples = samples.filter(row => row.atEpochMs >= startedAtEpochMs);
    const playbackForecasts = forecasts.filter(row => row.atEpochMs >= startedAtEpochMs);
    const ledger = exported.shadow?.ledger;
    const nativeEvents = (ledger?.events ?? []).filter(row => row.type === 'nativeInitRender');
    const eventAtEpoch = row => Number.isFinite(row?.wallTimeMs) &&
      Number.isFinite(exported.shadow?.reportedAtEpochMs) &&
      Number.isFinite(exported.shadow?.reportedMonotonicMs)
      ? exported.shadow.reportedAtEpochMs - exported.shadow.reportedMonotonicMs + row.wallTimeMs : null;
    const predictionOutcomes = { matched: 0, falsePositive: 0, pending: 0, censored: 0 };
    for (const prediction of ledger?.predictions ?? []) if (eventAtEpoch(prediction.selected) >= startedAtEpochMs &&
      Object.hasOwn(predictionOutcomes, prediction.status)) predictionOutcomes[prediction.status]++;
    const summary = { buildId: expected.buildId, version: expected.version,
      resourceId: exported.session.resourceId, epoch: exported.epoch,
      durationMs: exported.reference.durationMs, finalClock: exported.clock,
      ended: true, rawSampleCount: samples.length, rawForecastCount: forecasts.length,
      sampleCount: playbackSamples.length, forecastCount: playbackForecasts.length,
      forecastKnown: playbackForecasts.filter(row => row.known === true).length,
      forecastUnknown: playbackForecasts.filter(row => row.known !== true).length,
      forecastItems: playbackForecasts.reduce((count, row) => count + (Array.isArray(row.items) ? row.items.length : 0), 0),
      shadowKnown: exported.shadow?.known === true,
      shadowCapacityExceeded: exported.shadow?.capacityExceeded === true,
      shadowLedgerTruncated: ledger?.truncated === true,
      shadowUnknown: exported.shadow?.known !== true,
      instrumentationErrors: exported.shadow?.observed?.instrumentationErrors ?? null,
      nativeInitRender: nativeEvents.filter(row => eventAtEpoch(row) >= startedAtEpochMs).length,
      nativeInitRenderTimingUnknown: nativeEvents.filter(row => eventAtEpoch(row) === null).length,
      predictionOutcomes,
      interruptions: fullReferenceInterruptions(playbackSamples),
      observation: 'native Shadow lifecycle and forecast, not visible-pixel proof',
      zeroModelCalls: true, settingsHash: savedSettingsHash };
    await save('reference-full-summary', summary);
    completed = true;
    return { exported, summary };
  } catch (error) { failure = error; throw error; }
  finally {
    let cleanupFailure = null;
    if (startIssued) {
      try {
        const cleanup = await control('nativeSupply', { action: 'reference-cleanup' });
        assert.equal(cleanup.guardReleased, true);
        assert.equal(cleanup.closed, true);
        await save('reference-full-cleanup', cleanup);
      } catch (error) {
        await save('reference-full-cleanup-unconfirmed', { error: error instanceof Error ? error.message : String(error),
          startReplyReceived: owned, completed });
        cleanupFailure = error;
      }
    }
    const afterSettings = await control('rpc', { type: 'settings' });
    const afterLocalReply = await control('rpc', { type: 'local-control', control: { action: 'state' } });
    const afterIdentity = await control('rpc', { type: 'build-identity' });
    const after = afterLocalReply?.state;
    await save('reference-full-after', { settingsHash: settingsHash(afterSettings.settings),
      buildId: afterIdentity.buildId, local: after && { phase: after.phase, generation: after.generation,
        inferenceCalls: after.inferenceCalls, modelId: after.model?.id ?? null } });
    assert.equal(afterLocalReply?.ok, true, 'Final local state unavailable');
    assert.equal(afterIdentity.buildId, expected.buildId, 'Final build changed');
    assert.equal(settingsHash(afterSettings.settings), savedSettingsHash, 'Saved settings changed');
    assert.deepEqual([after.phase, after.generation, after.inferenceCalls, after.model?.id ?? null],
      [localBefore.phase, localBefore.generation, localBefore.inferenceCalls, localBefore.model?.id ?? null],
      'Local model phase, generation, inference calls or identity changed');
    if (cleanupFailure && !failure) throw cleanupFailure;
  }
}

const OFFICIAL_ROUNDS = Object.freeze([
  { mode: 'native-1', action: 'reference-official-1-start', requested: 1 },
  { mode: 'native-3', action: 'reference-official-3-start', requested: 3 },
  { mode: 'native-5', action: 'reference-official-5-start', requested: 5 },
  { mode: 'dom', action: 'reference-official-dom-start', requested: null },
]);
const OFFICIAL_REMAINING_MODES = Object.freeze(['native-3', 'native-5', 'dom']);

function officialReply(reply, expected, round, start = null) {
  assertNativePage(reply, expected, start ? { epoch: start.epoch, session: sessionHash(start.session) } : {});
  assert.equal(reply.ownedTargetTabId, start?.ownedTargetTabId ?? reply.ownedTargetTabId,
    'Official target tab changed');
  assert.ok(Number.isSafeInteger(reply.ownedTargetTabId), 'Official target tab ownership missing');
  assert.equal(reply.background?.protections?.effectiveZeroTransport, true, 'Official zero-transport guard missing');
  assert.equal(reply.background?.actualModelCalls, 0, 'Official observation issued a model call');
  assert.equal(reply.official?.mode, round.mode);
  assert.equal(reply.official?.fullVideo, true);
  assert.equal(typeof reply.official?.ended, 'boolean');
  assert.equal(reply.official?.truncated, false, 'Official playback sample ledger truncated');
  assert.ok(Array.isArray(reply.official?.samples), 'Official playback samples missing');
  assert.ok(Number.isFinite(reply.official.durationMs) && reply.official.durationMs > 0 &&
    reply.official.durationMs <= 3_600_000, 'Official video duration unavailable');
  if (start) {
    assert.equal(reply.official.runId, start.official.runId, 'Official run changed');
    assert.equal(reply.official.durationMs, start.official.durationMs, 'Official duration changed');
  }
  const report = reply.officialReport;
  assert.equal(report?.runId, reply.official.runId, 'Official report run mismatch');
  assert.equal(report.mode, round.mode, 'Official report mode mismatch');
  assert.equal(report.ready, true, 'Official observation not ready');
  assert.equal(report.stopped, false, 'Official observer stopped before playback ended');
  assert.ok(!report.error, `Official observer error: ${report.error}`);
  assert.equal(report.preTime?.requested, round.requested, 'Official preTime request mismatch');
  assert.equal(report.preTime?.current, round.requested ?? report.preTime.original,
    'Official preTime does not match the requested mode');
  assert.equal(report.preTime?.cadence, round.requested ?? report.preTime.originalCadence,
    'Official scheduler cadence does not match the requested mode');
  assert.equal(report.capacityExceeded, false, 'Official observation exceeded capacity');
  assert.equal(report.instrumentationErrors, 0, 'Official instrumentation failed');
  assert.equal(report.methodHooks, round.mode !== 'dom', 'Unexpected native method hooks');
  assert.ok(Array.isArray(report.events) && Array.isArray(report.dom), 'Official observation ledgers missing');
  assert.ok(report.metadata && report.settingsEvidence, 'Official observation evidence missing');
  if (round.mode !== 'dom') {
    assert.ok(Array.isArray(report.sourcePool), 'Official source pool missing');
    assert.ok(typeof report.nativeContracts?.fetchAndInitDm === 'string' &&
      typeof report.nativeContracts?.shouldFetchAndInitDm === 'string', 'Native cadence contract missing');
  }
  return reply;
}

function officialDelta(reply, offsets) {
  const report = reply.officialReport;
  const delta = {};
  for (const [name, rows] of Object.entries({ events: report.events, samples: reply.official.samples })) {
    assert.ok(rows.length >= offsets[name], `Official ${name} ledger reset`);
    delta[name] = rows.slice(offsets[name]); offsets[name] = rows.length;
  }
  // DOM rows gain visibility/removal evidence after first sighting. Persist each
  // changed revision, not just newly allocated elements.
  delta.dom = report.dom.filter(row => {
    const key = `${row.elementId}:${row.occurrence ?? 0}`, value = JSON.stringify(row);
    if (offsets.domSeen.get(key) === value) return false;
    offsets.domSeen.set(key, value); return true;
  });
  const pool = Array.isArray(report.sourcePool) ? report.sourcePool : [];
  delta.sourcePool = pool.filter(row => {
    const key = JSON.stringify([row.dmid, row.text, row.stimeMs, row.mode, row.rawMode]);
    if (offsets.sourceSeen.has(key)) return false;
    offsets.sourceSeen.add(key); return true;
  });
  return { mode: report.mode, runId: report.runId, clock: reply.clock,
    ended: reply.official.ended, counts: { events: report.events.length, dom: report.dom.length,
    sourcePool: pool.length, sourcePoolUnique: offsets.sourceSeen.size,
    samples: reply.official.samples.length },
    capacityExceeded: report.capacityExceeded,
    instrumentationErrors: report.instrumentationErrors, ...delta };
}

function assertOfficialPlaybackContinuous(reply) {
  const afterStart = reply.official.startedAtEpochMs + 100;
  const interrupted = reply.official.samples.find(row => row.atEpochMs > afterStart && !row.ended &&
    (row.visible === false || row.seeking === true ||
      Number.isFinite(row.playbackRate) && row.playbackRate !== 1));
  if (interrupted) throw Error(`Official ${reply.official.mode} playback interrupted at ` +
    `${interrupted.mediaTimeMs}ms: visible=${interrupted.visible}, ` +
    `seeking=${interrupted.seeking}, rate=${interrupted.playbackRate}`);
}

/** Four independent full-video rounds; each starts in a newly owned tab under the zero-call guard. */
export async function runOfficialNativeReference({ control, expected, save, sleep = delay,
  now = Date.now, log = console.log, rounds = OFFICIAL_ROUNDS.map(row => row.mode) }) {
  assert.ok(Array.isArray(rounds) && (rounds.length === OFFICIAL_ROUNDS.length &&
    rounds.every((mode, index) => mode === OFFICIAL_ROUNDS[index].mode) ||
    rounds.length === OFFICIAL_REMAINING_MODES.length &&
    rounds.every((mode, index) => mode === OFFICIAL_REMAINING_MODES[index]) ||
    rounds.length === 1 && rounds[0] === 'dom'),
  'Official rounds must be all four or the fixed 3/5/DOM continuation');
  const selected = OFFICIAL_ROUNDS.filter(row => rounds.includes(row.mode));
  const identity = await control('rpc', { type: 'build-identity' });
  const settings = await control('rpc', { type: 'settings' });
  const localReply = await control('rpc', { type: 'local-control', control: { action: 'state' } });
  assert.equal(identity.buildId, expected.buildId);
  assert.equal(identity.version, expected.version);
  assert.equal(identity.idle, true, 'Background must be idle');
  assert.equal(settings.settings?.enabled, false, 'Saved translation must be disabled');
  assert.equal(settings.settings?.bilibiliNativeTranslationOnly, false, 'Strict mode must be off');
  assert.equal(localReply?.ok, true, 'Local state unavailable');
  const localBefore = localReply.state;
  assert.ok(['idle', 'ready'].includes(localBefore?.phase) && localBefore.active === 0 &&
    localBefore.queued === 0 && Number.isSafeInteger(localBefore.generation) &&
    Number.isSafeInteger(localBefore.inferenceCalls), 'Local model must be idle');
  const savedSettingsHash = settingsHash(settings.settings);
  await save('reference-official-before', { build: identity, settingsHash: savedSettingsHash,
    local: localBefore });
  const outcomes = [], tabIds = new Set();
  for (const round of selected) {
    let startIssued = false, start = null, last = null, latestResponse = null, failure = null;
    try {
      startIssued = true;
      start = officialReply(await control('nativeSupply', { action: round.action }, 45_000), expected, round);
      assert.ok(!tabIds.has(start.ownedTargetTabId), 'Official round reused an owned tab');
      tabIds.add(start.ownedTargetTabId);
      last = start;
      assert.ok(Number.isFinite(start.official.startedAtEpochMs) && start.official.startedAtEpochMs > 0,
        'Official playback timestamp unavailable');
      await save(`reference-official-${round.mode}-start`, start);
      assertOfficialPlaybackContinuous(start);
      const deadline = now() + start.official.durationMs + 60_000;
      const maxSamples = Math.ceil((start.official.durationMs + 60_000) / 2000) + 1;
      const offsets = { events: 0, samples: 0, domSeen: new Map(), sourceSeen: new Set() };
      let lastProgressAt = now(), lastMediaMs = start.clock.mediaTimeMs, lastLogAt = now();
      for (let sample = 1; !last.official.ended; sample++) {
        if (sample > maxSamples || now() > deadline)
          throw Error(`Official ${round.mode} exceeded video duration plus 60 seconds`);
        await sleep(2000);
        latestResponse = await control('nativeSupply', { action: 'reference-snapshot' });
        last = officialReply(latestResponse, expected, round, start);
        await save(`reference-official-${round.mode}-snapshot-${String(sample).padStart(4, '0')}`,
          officialDelta(last, offsets));
        assertOfficialPlaybackContinuous(last);
        if (last.clock.mediaTimeMs > lastMediaMs + 100) {
          lastProgressAt = now(); lastMediaMs = last.clock.mediaTimeMs;
        }
        if (!last.official.ended && now() - lastProgressAt >= 12_000)
          throw Error(`Official ${round.mode} playback stopped for at least 12 seconds`);
        if (now() - lastLogAt >= 15_000) {
          lastLogAt = now();
          log(JSON.stringify({ phase: 'reference-official-progress', round: OFFICIAL_ROUNDS.indexOf(round) + 1,
            mode: round.mode, mediaTimeMs: last.clock.mediaTimeMs,
            events: last.officialReport.events.length, dom: last.officialReport.dom.length }));
        }
      }
      assert.equal(last.official.ended, true);
      const stopped = await control('nativeSupply', { action: 'reference-stop' });
      assertNativePage(stopped, expected, { epoch: start.epoch, session: sessionHash(start.session) });
      assert.equal(stopped.clock.paused, true, 'Official playback not paused at stop');
      assert.equal(stopped.officialReport?.runId, start.official.runId);
      assert.equal(stopped.officialReport?.preTime?.restored, true, 'Official preTime restoration unconfirmed');
      assert.equal(stopped.officialReport?.preTime?.current, stopped.officialReport?.preTime?.original,
        'Official preTime was not restored');
      assert.equal(stopped.officialReport?.preTime?.cadence, stopped.officialReport?.preTime?.originalCadence,
        'Official scheduler cadence was not restored');
      assert.equal(stopped.officialReport?.methodHooks, false, 'Official hooks remain installed');
      assert.equal(stopped.officialReport?.stopped, true, 'Official observer did not stop');
      assert.equal(stopped.background?.actualModelCalls, 0);
      await save(`reference-official-${round.mode}-export`, stopped);
      assert.ok(round.mode === 'dom' || Array.isArray(stopped.officialReport.sourcePool),
        'Official native source pool missing');
      outcomes.push({ mode: round.mode, runId: start.official.runId,
        tabId: start.ownedTargetTabId, durationMs: start.official.durationMs,
        playbackSamples: stopped.official.samples.length,
        interruptions: fullReferenceInterruptions(stopped.official.samples.filter(row =>
          row.atEpochMs >= start.official.startedAtEpochMs)),
        events: stopped.officialReport.events.length, dom: stopped.officialReport.dom.length,
        sourcePool: stopped.officialReport.sourcePool?.length ?? 0 });
    } catch (error) {
      failure = error;
      if (startIssued) await save(`reference-official-${round.mode}-failure-evidence`, {
        error: error instanceof Error ? error.message : String(error),
        lastVerifiedSnapshot: last,
        ...(latestResponse && latestResponse !== last ? { failedSnapshotResponse: latestResponse } : {}),
      });
      throw error;
    }
    finally {
      if (startIssued) {
        try {
          const cleanup = await control('nativeSupply', { action: 'reference-cleanup' });
          assert.equal(cleanup.guardReleased, true, 'Official guard not released');
          assert.equal(cleanup.closed, true, 'Official owned tab not closed');
          if (start) assert.equal(cleanup.ownedTargetTabId, start.ownedTargetTabId,
            'Official cleanup closed a different tab');
          await save(`reference-official-${round.mode}-cleanup`, cleanup);
        } catch (error) {
          await save(`reference-official-${round.mode}-cleanup-unconfirmed`, {
            error: error instanceof Error ? error.message : String(error), startReplyReceived: !!start });
          if (!failure) throw error;
        }
      }
      const afterSettings = await control('rpc', { type: 'settings' });
      const afterLocalReply = await control('rpc', { type: 'local-control', control: { action: 'state' } });
      const afterIdentity = await control('rpc', { type: 'build-identity' });
      const after = afterLocalReply?.state;
      await save(`reference-official-${round.mode}-after`, { settingsHash: settingsHash(afterSettings.settings),
        buildId: afterIdentity.buildId, local: after });
      assert.equal(settingsHash(afterSettings.settings), savedSettingsHash, 'Saved settings changed');
      assert.equal(afterIdentity.buildId, expected.buildId, 'Official build changed');
      assert.equal(afterIdentity.idle, true, 'Background not idle after official round');
      assert.equal(afterLocalReply?.ok, true, 'Final local state unavailable');
      assert.deepEqual([after.phase, after.generation, after.inferenceCalls, after.model?.id ?? null,
        after.active, after.queued],
      [localBefore.phase, localBefore.generation, localBefore.inferenceCalls,
        localBefore.model?.id ?? null, 0, 0], 'Local model state changed');
    }
  }
  await save('reference-official-summary', { buildId: expected.buildId, version: expected.version,
    zeroModelCalls: true, settingsHash: savedSettingsHash, selectedModes: selected.map(row => row.mode), rounds: outcomes });
  return { rounds: outcomes };
}

export async function prepareNativeSupply({ control, expected, session, checkpoint, save,
  refreshConnection = async () => {}, sleep = delay, recovering = false }) {
  if (recovering) {
    assert.equal(session.phaseName, 'main', 'Only the original main preparation can be recovered');
    assert.equal(session.runIssued, false, 'Playback has already been issued');
    assert.ok(session.taskId && session.runId && session.modelId &&
      session.phase === 'attention-required' && (session.resumePhase === 'reloading' ||
        session.resumePhase === 'recovery-issuing' && session.error === 'NATIVE_SUPPLY_RECOVERY_NOT_ZERO_CALL'),
    'A recoverable preparation checkpoint is required');
  }
  const saved = await control('rpc', { type: 'settings' });
  assert.equal(saved.settings?.enabled, false, 'Saved translation must be disabled');
  if (recovering || session.authorizedExtraLoad) assert.equal(settingsHash(saved.settings), session.savedSettingsHash,
    'Saved settings differ from the original preparation');
  let savedSettingsHash = settingsHash(saved.settings);
  let identity = await control('rpc', { type: 'build-identity' });
  assert.equal(identity.idle, true, 'Background busy');
  if (identity.buildId !== expected.buildId || identity.version !== expected.version) {
    await checkpoint('reloading', { savedSettingsHash });
    await control('reload'); await sleep(500); await refreshConnection();
    identity = await control('rpc', { type: 'build-identity' });
  }
  assert.equal(identity.buildId, expected.buildId);
  assert.equal(identity.version, expected.version);
  assert.equal(identity.idle, true);
  const currentSettings = (await control('rpc', { type: 'settings' })).settings;
  assert.ok(currentSettings && Object.entries(saved.settings).every(([key, value]) =>
    JSON.stringify(currentSettings[key]) === JSON.stringify(value)),
  'Saved settings changed on reload');
  savedSettingsHash = settingsHash(currentSettings);
  if (recovering) await checkpoint('recovery-issuing', { savedSettingsHash });
  const prepared = await control('nativeSupply', { action: recovering ? 'recover-prepare' : 'prepare', taskId: session.taskId,
    runId: session.runId, phase: session.phaseName, modelId: session.modelId,
    fromMs: session.fromMs, toMs: session.toMs,
    ...(session.authorizedExtraLoad ? { authorizedExtraLoad: true } : {}),
    ...(session.phaseName === 'repair' ? { repairReason: session.repairReason } : {}) }, 180_000);
  assertNativePage(prepared.preparedPage, expected, { prepareAt: session.fromMs });
  assertNativePage(prepared, expected, { epoch: prepared.preparedPage.epoch });
  assert.equal(prepared.host?.grant?.state, 'prepared');
  assert.equal(prepared.host.grant.modelId, session.modelId);
  assert.equal(prepared.host.grant.modelIdentityKind, 'metadata-only-sha256');
  assert.equal(prepared.host.grant.epoch, prepared.epoch);
  assert.equal(prepared.host.grant.session.sessionId, prepared.session.sessionId);
  assert.equal(prepared.host.grant.fromMs, session.fromMs);
  assert.equal(prepared.host.grant.toMs, session.toMs);
  assertNativeBudget(prepared.host);
  if (session.authorizedExtraLoad) {
    assert.equal(prepared.host.grant.modelLoads, 3, 'Additional model load count was not preserved');
    assert.equal(prepared.host.budget.phases.main.runId, session.previousRunId, 'Original budget run was replaced');
  }
  await save('prepared', { page: prepared, identity });
  await checkpoint('prepared', { expectedBuildId: expected.buildId, expectedVersion: expected.version,
    sourceHash: expected.sourceHash, savedSettingsHash, pageSessionHash: sessionHash(prepared.session),
    ownedTargetTabId: prepared.ownedTargetTabId, epoch: prepared.epoch,
    instanceId: prepared.host.grant.instanceId, modelIdentity: prepared.host.grant.modelIdentity,
    configIdentity: prepared.host.grant.configIdentity, runIssued: false });
  return prepared;
}

export async function runNativeSupply({ control, expected, session, checkpoint, save, sleep = delay }) {
  assert.equal(session.runIssued, false, 'Start was already issued');
  const before = assertNativeOwner(await control('nativeSupply', { action: 'status' }), expected, session, 'prepared');
  assert.equal(before.state, 'armed');
  await checkpoint('start-issuing', { runIssued: true });
  const started = assertNativeOwner(await control('nativeSupply', { action: 'run' }), expected, session, 'running');
  await save(session.cacheOnly ? 'replay-started' : 'cold-started', started);
  let last = started, drained = false;
  const end = Date.now() + 85_000;
  for (let sample = 0; sample < 44; sample++) {
    await sleep(2000);
    last = assertNativeOwner(await control('nativeSupply', { action: 'status' }), expected, session);
    if (last.state === 'paused' && last.clock.mediaTimeMs < session.toMs) {
      await save('interrupted', last);
      throw Error(`Native-supply paused before the end: ${last.reason || 'unknown'}`);
    }
    if (last.clock.mediaTimeMs >= session.toMs && !drained) {
      drained = true;
      last = assertNativeOwner(await control('nativeSupply', { action: 'drain' }), expected, session);
    }
    if (last.clock.mediaTimeMs >= session.toMs + 7000 && last.clock.paused === true) break;
    if (Date.now() > end) throw Error('Native-supply video did not finish within 85 seconds');
  }
  assert.ok(last.clock.mediaTimeMs >= session.toMs + 7000, 'Tail observation incomplete');
  assert.equal(last.clock.paused, true, 'Experiment video must be paused');
  assertNativeOwner(await control('nativeSupply', { action: 'stop' }), expected, session, 'stopped');
  const exported = assertNativeOwner(await control('nativeSupply', { action: 'export' }), expected, session, 'stopped');
  const summary = nativeSupplySummary(exported, exported.host);
  if (session.cacheOnly) assert.equal(exported.host.nativeSupply?.cacheOnly, true);
  await save(session.cacheOnly ? 'replay-export' : 'cold-export', exported);
  await save(session.cacheOnly ? 'replay-summary' : 'cold-summary', summary);
  await checkpoint(session.cacheOnly ? 'replay-complete' : 'cold-complete', {
    lastSummary: summary, ...(session.cacheOnly ? {} : { coldBudget: exported.host.budget.total }),
  });
  return { exported, summary };
}

export async function replayNativeSupply({ control, expected, session, checkpoint, save }) {
  assert.equal(session.phase, 'cold-complete', 'Cold run must stop before replay');
  assert.ok(!session.cacheOnly && !session.replayIssued && session.coldBudget, 'Replay already spent');
  const stopped = assertNativeOwner(await control('nativeSupply', { action: 'status' }), expected, session, 'stopped');
  assert.equal(stopped.host.activeRequests, 0);
  await checkpoint('replay-issuing', { replayIssued: true });
  const reply = await control('nativeSupply', { action: 'replay' });
  assertNativePage(reply, expected, { session: session.pageSessionHash, prepareAt: session.fromMs });
  assert.equal(reply.host?.grant?.state, 'prepared');
  assert.equal(reply.host.grant.cacheOnly, true, 'Replay is not cache-only');
  assert.notEqual(reply.host.grant.epoch, session.epoch, 'Replay reused playback epoch');
  assert.notEqual(reply.host.grant.instanceId, session.instanceId, 'Replay reused permit');
  assertNativeBudget(reply.host, session.coldBudget);
  await save('replay-prepared', reply);
  await checkpoint('replay-prepared', { epoch: reply.epoch, instanceId: reply.host.grant.instanceId,
    cacheOnly: true, runIssued: false });
  return reply;
}

export async function cleanupNativeSupply({ control, expected, session, checkpoint, save }) {
  const receipt = await control('nativeSupply', { action: 'cleanup' });
  assert.equal(receipt?.guardReleased, true);
  assert.equal(receipt.host?.buildId, expected.buildId);
  assert.equal(receipt.host?.activeRequests, 0);
  assert.equal(receipt.host?.grant?.state, 'stopped');
  assertNativeBudget(receipt.host);
  await save('cleanup', receipt);
  await checkpoint('guard-released');
  const closed = await control('close-native-supply-owned');
  assert.equal(closed.tabId, session.ownedTargetTabId);
  await checkpoint('cleaned', { cleanupConfirmed: true });
  return { receipt, closed };
}

async function acquireLock() {
  await mkdir(NATIVE_SUPPLY_ARTIFACT_ROOT, { recursive: true });
  return open(LOCK_PATH, 'wx');
}
async function main(argv) {
  const args = parseNativeSupplyArgs(argv);
  if (args.command === 'help') {
    console.log('Usage: node scripts/verify-bilibili-native-supply.mjs reference|reference-full|reference-official|reference-official-remaining|reference-official-dom|prepare --model-id <registered-7B-ID>|recover-prepare|run|replay|status|cleanup');
    console.log('Repair: prepare --model-id <same-ID> --phase repair --reason <verified-fix> --from-ms <0..45000> --to-ms <up-to-15s-later>');
    console.log('Explicitly authorized recovery after cleaned failure: add --extra-model-load 1 (same task budget, no retry)');
    return;
  }
  const prior = await loadSession(NATIVE_SUPPLY_ARTIFACT_ROOT, ROUND);
  if (!['reference', 'reference-full', 'reference-official', 'reference-official-remaining', 'reference-official-dom', 'prepare'].includes(args.command) && !prior)
    throw Error('Prepare a native-supply task first');
  const lock = await acquireLock(), transport = createBilibiliRunnerTransport();
  let session = prior;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    if (args.command === 'prepare') {
      if (args.phase === 'main') assert.ok(!prior || prior.phase === 'cleaned', 'Main run already exists');
      else assertRepairContinuation(prior, args);
      session = await createSession(NATIVE_SUPPLY_ARTIFACT_ROOT, ROUND);
      Object.assign(session, { taskId: args.phase === 'repair' ? prior.taskId : randomUUID(), runId: randomUUID(),
        modelId: args.modelId, phaseName: args.phase, fromMs: args.fromMs,
        toMs: args.toMs, repairReason: args.repairReason, repairUsed: args.phase === 'repair' });
      if (args.authorizedExtraLoad) Object.assign(session, { authorizedExtraLoad: true,
        authorization: 'user-approved-one-extra-7b-load-and-at-most-15s-repair',
        previousRunId: prior.runId, previousSession: prior.id, savedSettingsHash: prior.savedSettingsHash });
      await writeSession(session, 'created');
    }
    if (args.command === 'recover-prepare') assert.ok(session?.phase === 'attention-required' &&
      (session.resumePhase === 'reloading' || session.resumePhase === 'recovery-issuing' &&
        session.error === 'NATIVE_SUPPLY_RECOVERY_NOT_ZERO_CALL') && session.runIssued === false && session.phaseName === 'main',
    'Only the existing failed main preparation may be recovered');
    const expected = await readJSON(resolve(EXTENSION, 'runtime-identity.json'));
    assert.equal(expected.sourceHash, createBuildIdentity(ROOT).sourceHash,
      'Fixed test build is stale; run the workspace updater before the browser run');
    await transport.connect();
    const control = (...parts) => transport.control(...parts);
    const checkpoint = (phase, extra) => writeSession(session, phase, extra);
    const save = async (name, result) => {
      const path = resolve(session.folder,
        `${String(session.seq).padStart(4, '0')}-${name}-${randomUUID().slice(0, 8)}.json`);
      await writeJSON(path, { at: new Date().toISOString(), result }); return path;
    };
    if (args.command === 'reference' || args.command === 'reference-full' ||
        args.command === 'reference-official' || args.command === 'reference-official-remaining' || args.command === 'reference-official-dom') {
      assert.ok(!prior || prior.phase === 'cleaned', 'Finish the existing native-supply task first');
      const folder = resolve(NATIVE_SUPPLY_ARTIFACT_ROOT,
        `${args.command}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
      await mkdir(folder);
      const saveReference = async (name, result) => {
        const path = resolve(folder, `${name}.json`);
        await writeJSON(path, { at: new Date().toISOString(), result }); return path;
      };
      const runner = args.command === 'reference-official' || args.command === 'reference-official-remaining' || args.command === 'reference-official-dom'
        ? runOfficialNativeReference :
        args.command === 'reference-full' ? runFullNativeReference : runNativeReference;
      const result = await runner(
        { control, expected, save: saveReference,
          ...(args.command === 'reference-official-remaining' ? { rounds: [...OFFICIAL_REMAINING_MODES] } :
            args.command === 'reference-official-dom' ? { rounds: ['dom'] } : {}) });
      console.log(JSON.stringify({ phase: args.command === 'reference-official-dom' ? 'zero-call-dom-only-reference' : args.command === 'reference-official-remaining' ? 'zero-call-remaining-official-reference' :
        args.command === 'reference-official' ? 'zero-call-four-round-official-reference' :
        args.command === 'reference-full' ? 'zero-call-full-native-reference' : 'zero-call-native-reference',
      directory: folder, summary: result.summary ?? result.rounds }));
      return;
    }
    assert.ok(session && session.phase !== 'cleaned', 'Task already cleaned');
    if (args.command === 'prepare' || args.command === 'recover-prepare') {
      const result = await prepareNativeSupply({ control, expected, session, checkpoint, save,
        refreshConnection: async () => { transport.openPage(); await transport.waitHello(30_000); },
        recovering: args.command === 'recover-prepare' });
      console.log(JSON.stringify({ phase: 'prepared', directory: session.folder, tabId: result.ownedTargetTabId,
        taskId: session.taskId, runId: session.runId, modelId: session.modelId }));
    } else if (args.command === 'run') {
      const result = await runNativeSupply({ control, expected, session, checkpoint, save });
      console.log(JSON.stringify({ phase: session.phase, directory: session.folder, summary: result.summary }));
    } else if (args.command === 'replay') {
      const result = await replayNativeSupply({ control, expected, session, checkpoint, save });
      console.log(JSON.stringify({ phase: 'replay-prepared', directory: session.folder, epoch: result.epoch }));
    } else if (args.command === 'status') {
      const reply = assertNativeOwner(await control('nativeSupply', { action: 'status' }), expected, session);
      console.log(JSON.stringify({ phase: session.phase, state: reply.state, clock: reply.clock,
        budget: reply.host.budget?.total, cacheOnly: reply.host.nativeSupply?.cacheOnly }));
    } else {
      const result = await cleanupNativeSupply({ control, expected, session, checkpoint, save });
      console.log(JSON.stringify({ phase: 'cleaned', directory: session.folder, tabId: result.closed.tabId }));
    }
  } catch (error) {
    const message = transport.redact(error instanceof Error ? error.message : String(error));
    if (session && session.phase !== 'cleaned') await writeSession(session, 'attention-required', { error: message,
      resumePhase: session.phase === 'attention-required' ? session.resumePhase : session.phase });
    else console.error(message);
    process.exitCode = 1;
  } finally { await transport.close(); await lock.close(); await unlink(LOCK_PATH); }
}
if (process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => '') ===
    await realpath(fileURLToPath(import.meta.url)))
  await main(process.argv.slice(2));
