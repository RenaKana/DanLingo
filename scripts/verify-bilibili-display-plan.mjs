// Bounded, page-local display-plan verification. It never loads a model or exports implicitly.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, open, unlink, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, loadSession, writeSession } from './verify-bilibili-user-filters.mjs';
import { createBuildIdentity } from './build-identity.mjs';
import { writeJSON } from './bilibili-dispatch-ledger.mjs';
import { analyzeBilibiliDisplayPlan } from './bilibili-display-plan-analysis.mjs';
import { createBilibiliRunnerTransport } from './bilibili-runner-transport.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = resolve(ROOT, '../DanLingo-Workspace');
const EXTENSION = resolve(WORKSPACE, 'testing/current/extension');
const ARTIFACT = resolve(ROOT, '.artifacts/bilibili-display-plan');
export const DISPLAY_PLAN_ARTIFACT_ROOT = resolve(ARTIFACT, 'v1');
const ROUND = 'v1';
// Share the established lock with the Bilibili user-filter runner.
const LOCK_PATH = resolve(ROOT, '.artifacts/bilibili-user-filters/runner.lock');
export const DISPLAY_PLAN_DURATION_MS = 35_000;
export const DISPLAY_PLAN_SAMPLE_INTERVAL_MS = 3_000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const optional = async path => readJSON(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
export const settingsHash = settings => createHash('sha256').update(JSON.stringify(settings)).digest('hex');
export function pageSessionHash(session) {
  assert.ok(session && session.platform === 'bilibili' && session.scenario === 'video' &&
    typeof session.resourceId === 'string' && session.resourceId && typeof session.sessionId === 'string' && session.sessionId,
  'Page session identity is incomplete');
  return settingsHash({ platform: session.platform, scenario: session.scenario, resourceId: session.resourceId,
    urlResourceId: session.urlResourceId ?? null, sessionId: session.sessionId });
}

export function assertDisplayPlanReceipt(receipt, expectedBuildId, action) {
  assert.equal(receipt?.ok, true, `Display-plan ${action} was not accepted`);
  assert.equal(receipt.buildId, expectedBuildId, 'Display-plan page build changed');
  assert.equal(receipt.background?.buildId, expectedBuildId, 'Display-plan background build changed');
  assert.equal(receipt.background.actualModelCalls, 0, 'Model call budget violated');
  assert.ok(Number.isSafeInteger(receipt.background.blockedTransports) && receipt.background.blockedTransports >= 0);
  assert.equal(receipt.background.idle, true, 'Background did not remain idle');
  assert.equal(receipt.background.zeroModelGuard, action !== 'cleanup', 'Zero-model guard state changed');
  if (!(action === 'cleanup' && receipt.closedTargetEvidence?.exists === false)) {
    assert.equal(receipt.report?.coverage?.mainBuildId, expectedBuildId, 'Coverage build changed');
    assert.equal(receipt.report?.actualModelCalls, 0, 'Model call budget violated');
    assert.equal(receipt.report?.modelLoads, 0, 'Model load budget violated');
    assert.equal(receipt.report?.nativeSettingsWrites, 0, 'Native settings changed');
  }
  if (action === 'cleanup') assert.equal(receipt.report?.restored, true, 'Page restoration unconfirmed');
  return receipt;
}

function assertBodyFreeStatus(receipt) {
  const simulation = receipt.report?.simulation;
  assert.ok(simulation && typeof simulation === 'object', 'Display-plan simulation status missing');
  assert.equal(simulation.inputFrames, undefined, 'Status returned the input stream');
  assert.equal(typeof simulation.stopReason, 'string', 'Simulation stop reason missing');
  assert.ok(simulation.limits && typeof simulation.limits === 'object', 'Simulation limits missing');
  for (const key of ['inputFrames', 'inputBytes', 'sourcePool', 'sideRecords'])
    assert.ok(Number.isSafeInteger(simulation.limits[key]) && simulation.limits[key] > 0, `Simulation ${key} limit missing`);
  assert.ok(Number.isSafeInteger(simulation.inputFrameCount) && simulation.inputFrameCount >= 0 &&
    simulation.inputFrameCount <= simulation.limits.inputFrames, 'Input-frame count exceeds its declared limit');
  assert.ok(Number.isSafeInteger(simulation.inputBytes) && simulation.inputBytes >= 0 &&
    simulation.inputBytes <= simulation.limits.inputBytes, 'Input trace exceeds its declared byte limit');
  assert.equal(typeof simulation.inputTruncated, 'boolean', 'Input-trace cap status missing');
  for (const name of ['A', 'B']) {
    const branch = simulation[name];
    assert.ok(branch && typeof branch === 'object', `Simulation branch ${name} missing`);
    assert.ok(Array.isArray(branch.events), `Simulation branch ${name} event history missing`);
    if (Array.isArray(branch.providerInputLog)) for (const item of branch.providerInputLog)
      assert.equal(Object.hasOwn(item, 'originalText'), false, 'Status exposed provider input text');
  }
  return simulation;
}

export function assertStablePageSession(receipt, expectedBuildId, expectedSessionHash, action = 'status') {
  assertDisplayPlanReceipt(receipt, expectedBuildId, action);
  assert.ok(receipt.session && typeof receipt.session === 'object', 'Page session identity missing');
  if (expectedSessionHash) assert.equal(pageSessionHash(receipt.session), expectedSessionHash,
    'Page session changed; preserving the existing planner is required');
  return receipt;
}

export function terminalTraceReason(receipt) {
  const simulation = receipt.report?.simulation;
  if (simulation?.inputTruncated === true || simulation?.stopReason === 'input-trace-budget-exhausted' ||
      simulation?.stopReason === 'record-budget-exhausted') return 'input-trace-budget-exhausted';
  if (simulation?.A?.truncation?.events > 0 || simulation?.B?.truncation?.events > 0)
    return 'event-history-truncated';
  return null;
}

export async function prepareDisplayPlan({ control, expected, checkpoint, sleep = delay, refreshConnection }) {
  const before = await control('rpc', { type: 'settings' });
  assert.equal(before.settings?.enabled, false, 'Saved translation must be disabled');
  const beforeHash = settingsHash(before.settings);
  const identity = await control('rpc', { type: 'build-identity' });
  assert.equal(identity.idle, true, 'Background is busy');
  let current = identity;
  if (current.buildId !== expected.buildId || current.version !== expected.version) {
    await checkpoint('reloading', { savedSettingsHash: beforeHash, expectedBuildId: expected.buildId });
    await control('reload');
    await sleep(500);
    await refreshConnection();
    current = await control('rpc', { type: 'build-identity' });
    assert.equal(current.idle, true, 'Reloaded background is busy');
  }
  assert.equal(current.buildId, expected.buildId, 'Loaded background build mismatch');
  assert.equal(current.version, expected.version, 'Loaded background version mismatch');
  const afterReload = await control('rpc', { type: 'settings' });
  assert.equal(afterReload.settings?.enabled, false, 'Saved translation must remain disabled');
  assert.equal(settingsHash(afterReload.settings), beforeHash, 'Settings changed during build reload');
  const prepared = await control('displayPlan', { action: 'prepare' });
  assertDisplayPlanReceipt(prepared, expected.buildId, 'prepare');
  const sessionHash = pageSessionHash(prepared.session);
  await checkpoint('prepared', { expectedBuildId: expected.buildId, expectedVersion: expected.version,
    sourceHash: expected.sourceHash, savedSettingsHash: beforeHash, pageSessionHash: sessionHash,
    reloadVerified: true, runIssued: false });
  return { prepared, savedSettingsHash: beforeHash, pageSessionHash: sessionHash };
}

export async function observeDisplayPlan({ control, expectedBuildId, expectedSessionHash,
  sampleStartedAt, checkpoint, save, now = Date.now, sleep = delay }) {
  const deadline = sampleStartedAt + DISPLAY_PLAN_DURATION_MS;
  let nextAt = sampleStartedAt + DISPLAY_PLAN_SAMPLE_INTERVAL_MS;
  while (nextAt <= now()) nextAt += DISPLAY_PLAN_SAMPLE_INTERVAL_MS;
  let sample = 0;
  while (now() < deadline) {
    const sampleAt = Math.min(nextAt, deadline);
    await sleep(Math.max(0, sampleAt - now()));
    const status = await control('displayPlan', { action: 'status' });
    assertStablePageSession(status, expectedBuildId, expectedSessionHash);
    const simulation = assertBodyFreeStatus(status);
    const terminal = terminalTraceReason(status);
    sample++;
    await save(`status-${sample}`, status);
    if (terminal) {
      await checkpoint('trace-exhausted', { traceExhausted: true, terminalStopReason: terminal,
        lastStatusAtMs: now(), sampleCount: sample });
      throw Error(`DISPLAY_PLAN_${terminal.toUpperCase().replaceAll('-', '_')}_CLEANUP_REQUIRED`);
    }
    await checkpoint('sampling', { lastStatusAtMs: now(), sampleCount: sample,
      stopReason: simulation.stopReason, inputFrameCount: simulation.inputFrameCount,
      inputTruncated: simulation.inputTruncated });
    if (sampleAt >= deadline || now() >= deadline) break;
    nextAt += DISPLAY_PLAN_SAMPLE_INTERVAL_MS;
  }
  await checkpoint('sample-window-elapsed', { sampleStartedAt, sampleDeadlineAt: deadline, lastStatusAtMs: now() });
  return { sampleCount: sample, sampleDeadlineAt: deadline };
}

export async function runDisplayPlan({ control, expectedBuildId, expectedSessionHash, session,
  checkpoint, save, now = Date.now, sleep = delay }) {
  assert.equal(session.runIssued, false, 'Run may only be issued once; use resume to continue observation');
  const sampleStartedAt = now();
  await checkpoint('run-issuing', { runIssued: true, sampleStartedAt,
    sampleDeadlineAt: sampleStartedAt + DISPLAY_PLAN_DURATION_MS });
  const started = await control('displayPlan', { action: 'run' });
  assertStablePageSession(started, expectedBuildId, expectedSessionHash, 'run');
  if (started.report.simulation) assertBodyFreeStatus(started);
  const terminal = terminalTraceReason(started);
  if (terminal) {
    await checkpoint('trace-exhausted', { traceExhausted: true, terminalStopReason: terminal,
      lastStatusAtMs: now() });
    throw Error(`DISPLAY_PLAN_${terminal.toUpperCase().replaceAll('-', '_')}_CLEANUP_REQUIRED`);
  }
  const runReceiptPath = await save('run-started', started);
  await checkpoint('sampling', { runIssued: true, sampleStartedAt,
    sampleDeadlineAt: sampleStartedAt + DISPLAY_PLAN_DURATION_MS, runReceiptPath });
  return observeDisplayPlan({ control, expectedBuildId, expectedSessionHash, sampleStartedAt,
    checkpoint, save, now, sleep });
}

function assertExportReceipt(receipt, expectedBuildId, expectedSessionHash) {
  assertStablePageSession(receipt, expectedBuildId, expectedSessionHash, 'export');
  const simulation = receipt.report?.simulation;
  assert.ok(simulation && typeof simulation === 'object', 'Display-plan export missing');
  assert.ok(Array.isArray(simulation.inputFrames), 'Display-plan input stream missing');
  assert.equal(simulation.inputTruncated, false, 'Input trace exceeded its cap; cleanup is required');
  assert.equal(simulation.inputFrameCount, simulation.inputFrames.length, 'Display-plan input stream is incomplete');
  assert.equal(typeof simulation.stopReason, 'string', 'Simulation stop reason missing');
  assert.ok(simulation.limits && typeof simulation.limits === 'object', 'Simulation limits missing');
  assert.ok(simulation.inputFrameCount <= simulation.limits.inputFrames, 'Input-frame limit exceeded');
  assert.ok(simulation.inputBytes <= simulation.limits.inputBytes, 'Input-byte limit exceeded');
  const containsPrivateMetadata = value => Array.isArray(value) ? value.some(containsPrivateMetadata)
    : value && typeof value === 'object' ? Object.entries(value).some(([key, item]) =>
      ['author', 'authorName', 'authorId', 'uid', 'ruleValues'].includes(key) || containsPrivateMetadata(item)) : false;
  assert.equal(containsPrivateMetadata(simulation), false, 'Export contains author or rule-value data');
  return simulation;
}

export function measurePlaybackWindow(simulation) {
  const frames = simulation?.inputFrames;
  assert.ok(Array.isArray(frames) && frames.length >= 2, 'Playback sample has too few input frames');
  const epochs = new Set(frames.map(frame => `${frame.resourceId}:${frame.epoch}`));
  assert.equal(epochs.size, 1, 'Playback sample crossed a resource or epoch boundary');
  const startIndex = frames.findIndex(frame => frame.paused === false && frame.seeking === false);
  assert.ok(startIndex >= 0, 'Playback never entered a running, non-seeking state');
  const activeFrames = frames.slice(startIndex);
  assert.ok(activeFrames.every(frame => frame.paused === false), 'Playback paused during the sample');
  assert.ok(activeFrames.every(frame => frame.seeking === false), 'Playback sought during the sample');
  const mediaTimes = activeFrames.map(frame => frame.mediaTimeMs);
  const wallTimes = activeFrames.map(frame => frame.wallTimeMs);
  assert.ok(mediaTimes.every(Number.isFinite) && wallTimes.every(Number.isFinite), 'Playback clock samples missing');
  assert.ok(mediaTimes.every((time, index) => index === 0 || time >= mediaTimes[index - 1]), 'Media clock moved backwards');
  assert.ok(wallTimes.every((time, index) => index === 0 || time >= wallTimes[index - 1]), 'Wall clock moved backwards');
  assert.ok(wallTimes.every((time, index) => index === 0 || time - wallTimes[index - 1] <= 3000),
    'Playback input trace has a missing interval');
  const rates = activeFrames.map(frame => frame.playbackRate);
  assert.ok(rates.every(rate => Number.isFinite(rate) && Math.abs(rate - 1) <= 0.01),
    'Main playback sample must remain at 1x');
  const mediaDurationMs = mediaTimes.at(-1) - mediaTimes[0];
  const wallDurationMs = wallTimes.at(-1) - wallTimes[0];
  assert.ok(mediaDurationMs >= 30_000 && mediaDurationMs <= 40_000,
    `Playback advanced ${mediaDurationMs}ms; expected 30-40 seconds`);
  assert.ok(wallDurationMs >= 30_000 && wallDurationMs <= 40_000,
    `Playback was observed for ${wallDurationMs}ms; expected 30-40 seconds`);
  return { frameCount: frames.length, startupFrameCount: startIndex,
    activeFrameCount: activeFrames.length, resourceId: frames[0].resourceId, epoch: frames[0].epoch,
    mediaStartMs: mediaTimes[0], mediaEndMs: mediaTimes.at(-1), mediaDurationMs,
    wallStartMs: wallTimes[0], wallEndMs: wallTimes.at(-1), wallDurationMs, playbackRate: 1,
    pausedFrames: activeFrames.filter(frame => frame.paused).length,
    seekingFrames: activeFrames.filter(frame => frame.seeking).length };
}

export async function exportAndSeekDisplayPlan({ control, expectedBuildId, expectedSessionHash, session,
  checkpoint, save, sleep = delay, analyze = analyzeBilibiliDisplayPlan, read = readJSON }) {
  if (session.finalExportPath) {
    assert.ok(session.runReceiptPath && session.seekReceiptPath && session.preSeekExportPath,
      'Completed run is missing saved run, seek, or initial-export evidence');
    const runReceipt = (await read(session.runReceiptPath)).result;
    assertStablePageSession(runReceipt, expectedBuildId, expectedSessionHash, 'run');
    const seekReceipt = (await read(session.seekReceiptPath)).result;
    assertStablePageSession(seekReceipt, expectedBuildId, expectedSessionHash,
      seekReceipt.report?.playback?.seekCount === 1 ? 'seek' : 'status');
    assert.equal(seekReceipt.report?.playback?.seekCount, 1, 'Saved seek evidence is missing');
    const initialReceipt = (await read(session.preSeekExportPath)).result;
    const initialSimulation = assertExportReceipt(initialReceipt, expectedBuildId, expectedSessionHash);
    if (!session.playbackWindow) measurePlaybackWindow(initialSimulation);
    const finalReceipt = (await read(session.finalExportPath)).result;
    const simulation = assertExportReceipt(finalReceipt, expectedBuildId, expectedSessionHash);
    assert.equal(finalReceipt.report?.playback?.seekCount, 1, 'Saved export does not contain the single seek');
    const analysis = session.analysisPath ? (await read(session.analysisPath)).result : analyze(simulation);
    assert.equal(analysis.ok, true, `Display-plan analysis failed: ${(analysis.violations ?? []).join(', ')}`);
    if (!session.analysisPath) {
      const analysisPath = await save('analysis', analysis);
      await checkpoint('analyzed', { analysisPath, analysisOk: true, seekIssued: true, seekConfirmed: true });
    }
    return { simulation, analysis, reused: true };
  }

  if (!session.preSeekExportPath) {
    const exported = await control('displayPlan', { action: 'export' });
    const simulation = assertExportReceipt(exported, expectedBuildId, expectedSessionHash);
    const reason = terminalTraceReason(exported);
    if (reason) {
      await checkpoint('trace-exhausted', { traceExhausted: true, terminalStopReason: reason });
      throw Error(`DISPLAY_PLAN_${reason.toUpperCase().replaceAll('-', '_')}_CLEANUP_REQUIRED`);
    }
    const exportPath = await save('before-seek-export', exported);
    let playbackWindow;
    try { playbackWindow = measurePlaybackWindow(simulation); }
    catch (error) {
      await checkpoint('sample-invalid', { preSeekExportPath: exportPath, sampleValid: false,
        sampleFailure: error.message, seekIssued: false });
      throw error;
    }
    await save('playback-window', playbackWindow);
    await checkpoint('pre-seek-exported', { preSeekExportPath: exportPath,
      playbackWindow, sampleValid: true, exportedInputFrameCount: simulation.inputFrameCount, seekIssued: false });
  } else {
    const prior = (await read(session.preSeekExportPath)).result;
    const simulation = assertExportReceipt(prior, expectedBuildId, expectedSessionHash);
    if (!session.playbackWindow) {
      const playbackWindow = measurePlaybackWindow(simulation);
      await save('playback-window', playbackWindow);
      await checkpoint('pre-seek-exported', { playbackWindow, sampleValid: true });
    }
  }

  if (!session.seekIssued) {
    await checkpoint('seek-issuing', { seekIssued: true, seekConfirmed: false });
    const sought = await control('displayPlan', { action: 'seek' });
    assertStablePageSession(sought, expectedBuildId, expectedSessionHash, 'seek');
    assert.equal(sought.report?.playback?.seekCount, 1, 'Fixed seek was not confirmed');
    const seekReceiptPath = await save('seek-confirmed', sought);
    await checkpoint('seek-confirmed', { seekConfirmed: true, seekReceiptPath });
    await sleep(2000);
  } else if (!session.seekConfirmed) {
    const status = await control('displayPlan', { action: 'status' });
    assertStablePageSession(status, expectedBuildId, expectedSessionHash);
    assertBodyFreeStatus(status);
    if (status.report?.playback?.seekCount !== 1)
      throw Error('DISPLAY_PLAN_SEEK_OUTCOME_UNCERTAIN_CLEANUP_REQUIRED');
    const seekReceiptPath = await save('seek-recovered-status', status);
    await checkpoint('seek-confirmed', { seekConfirmed: true, seekReceiptPath, recoveredSeekReceipt: true });
  }

  const afterSeek = await control('displayPlan', { action: 'status' });
  assertStablePageSession(afterSeek, expectedBuildId, expectedSessionHash);
  assertBodyFreeStatus(afterSeek);
  assert.equal(afterSeek.report?.playback?.seekCount, 1, 'Seek count changed after confirmation');
  const finalExport = await control('displayPlan', { action: 'export' });
  const simulation = assertExportReceipt(finalExport, expectedBuildId, expectedSessionHash);
  assert.equal(finalExport.report?.playback?.seekCount, 1, 'Export did not retain the confirmed seek');
  const reason = terminalTraceReason(finalExport);
  if (reason) {
    await checkpoint('trace-exhausted', { traceExhausted: true, terminalStopReason: reason });
    throw Error(`DISPLAY_PLAN_${reason.toUpperCase().replaceAll('-', '_')}_CLEANUP_REQUIRED`);
  }
  const finalExportPath = await save('after-seek-export', finalExport);
  await checkpoint('final-exported', { finalExportPath,
    exportedInputFrameCount: simulation.inputFrameCount, seekIssued: true, seekConfirmed: true });
  const analysis = analyze(simulation);
  assert.equal(analysis.ok, true, `Display-plan analysis failed: ${(analysis.violations ?? []).join(', ')}`);
  const analysisPath = await save('analysis', analysis);
  await checkpoint('analyzed', { analysisPath, analysisOk: true, seekIssued: true, seekConfirmed: true });
  return { simulation, analysis, reused: false };
}

export async function resumeDisplayPlan({ control, expectedBuildId, expectedSessionHash, session,
  checkpoint, save, now = Date.now, sleep = delay }) {
  assert.equal(session.runIssued, true, 'No display-plan run to resume');
  if (session.traceExhausted) throw Error('DISPLAY_PLAN_TRACE_EXHAUSTED_CLEANUP_REQUIRED');
  const status = await control('displayPlan', { action: 'status' });
  assertStablePageSession(status, expectedBuildId, expectedSessionHash);
  const simulation = assertBodyFreeStatus(status);
  const terminal = terminalTraceReason(status);
  await save('resume-status', status);
  if (terminal) {
    await checkpoint('trace-exhausted', { traceExhausted: true, terminalStopReason: terminal,
      lastStatusAtMs: now() });
    throw Error(`DISPLAY_PLAN_${terminal.toUpperCase().replaceAll('-', '_')}_CLEANUP_REQUIRED`);
  }
  if (!session.runReceiptPath) {
    const runReceiptPath = await save('run-recovered-status', status);
    await checkpoint('run-recovered', { runReceiptPath, runRecoveredByStatus: true });
  }
  const startedAt = session.sampleStartedAt;
  assert.ok(Number.isSafeInteger(startedAt) && startedAt > 0, 'Run sample deadline missing');
  if (now() >= startedAt + DISPLAY_PLAN_DURATION_MS) {
    await checkpoint('sample-window-elapsed', { lastStatusAtMs: now(), stopReason: simulation.stopReason,
      inputFrameCount: simulation.inputFrameCount });
    return { sampleCount: 0, sampleDeadlineAt: startedAt + DISPLAY_PLAN_DURATION_MS, resumed: true };
  }
  await checkpoint('sampling', { lastStatusAtMs: now(), stopReason: simulation.stopReason,
    inputFrameCount: simulation.inputFrameCount });
  const observed = await observeDisplayPlan({ control, expectedBuildId, expectedSessionHash,
    sampleStartedAt: startedAt, checkpoint, save, now, sleep });
  return { ...observed, resumed: true };
}

export async function cleanupDisplayPlan({ control, expectedBuildId, savedSettingsHash: baseline,
  checkpoint, save, session, read = readJSON }) {
  let restored;
  if (session.guardReleased) {
    assert.ok(session.cleanupReceiptPath, 'Released-guard checkpoint is missing its receipt');
    restored = (await read(session.cleanupReceiptPath)).result;
    assertDisplayPlanReceipt(restored, expectedBuildId, 'cleanup');
    assert.equal(restored.guardReleased, true, 'Saved background guard release is unconfirmed');
  } else {
    restored = await control('displayPlan', { action: 'cleanup' });
    assertDisplayPlanReceipt(restored, expectedBuildId, 'cleanup');
    assert.equal(restored.guardReleased, true, 'Background guard release unconfirmed');
    const cleanupReceiptPath = await save('restored-and-guard-released', restored);
    await checkpoint('guard-released', { restored: true, guardReleased: true, cleanupReceiptPath });
  }
  let closed;
  if (session.ownedTargetClosed) {
    assert.ok(session.closedReceiptPath, 'Closed-target checkpoint is missing its receipt');
    closed = (await read(session.closedReceiptPath)).result;
  } else {
    if (!session.closeAttempted) await checkpoint('closing-owned-target', { closeAttempted: true });
    closed = await control('close-owned');
    assert.ok(closed.closed === true || closed.closed === false && session.closeAttempted,
      'Owned target closure or prior absence unconfirmed');
    const closedReceiptPath = await save('closed-owned', closed);
    await checkpoint('owned-target-closed', { ownedTargetClosed: true, closedReceiptPath,
      targetAlreadyAbsent: closed.closed === false });
  }
  const after = await control('rpc', { type: 'settings' });
  const unchanged = baseline ? settingsHash(after.settings) === baseline : null;
  if (baseline) assert.equal(unchanged, true, 'Saved settings changed during display-plan verification');
  await save('settings-check', { savedSettingsUnchanged: unchanged, savedSettingsHash: baseline ?? null });
  await checkpoint('cleaned', { restored: true, guardReleased: true, ownedTargetClosed: true,
    savedSettingsUnchanged: unchanged });
  return { restored, closed, savedSettingsUnchanged: unchanged };
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

async function createDisplayPlanSession() {
  return createSession(DISPLAY_PLAN_ARTIFACT_ROOT, ROUND);
}

async function main(command) {
  if (command === 'help') {
    console.log('Usage: node scripts/verify-bilibili-display-plan.mjs prepare|run|resume|cleanup');
    return;
  }
  assert.ok(['prepare', 'run', 'resume', 'cleanup'].includes(command), 'Unknown display-plan runner action');
  await mkdir(DISPLAY_PLAN_ARTIFACT_ROOT, { recursive: true });
  const lock = await acquireSharedRunnerLock();
  const transport = createBilibiliRunnerTransport();
  let session;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    session = await loadSession(DISPLAY_PLAN_ARTIFACT_ROOT, ROUND);
    if (command === 'resume' && !session) throw Error('No display-plan run to resume');
    if (command === 'resume' && session.phase === 'cleaned') throw Error('Display-plan session is already cleaned');
    if (command === 'cleanup' && session?.phase === 'cleaned') {
      console.log(JSON.stringify({ phase: 'cleaned', directory: session.folder,
        savedSettingsUnchanged: session.savedSettingsUnchanged, restored: session.restored,
        guardReleased: session.guardReleased, ownedTargetClosed: session.ownedTargetClosed }));
      return;
    }
    if (command !== 'cleanup' && (!session || session.phase === 'cleaned')) session = await createDisplayPlanSession();
    if (command === 'run' && session.runIssued) throw Error('Run already issued; use resume to continue without replay');
    if (command === 'resume' && session.traceExhausted) throw Error('DISPLAY_PLAN_TRACE_EXHAUSTED_CLEANUP_REQUIRED');

    let expected = null;
    if (command === 'prepare' || command === 'run' && !session.runIssued) {
      if (session.pageSessionHash && session.expectedBuildId && session.savedSettingsHash) {
        expected = { buildId: session.expectedBuildId, version: session.expectedVersion, sourceHash: session.sourceHash };
      } else expected = await ensureBuild(session);
    }
    await transport.connect();
    const control = (...args) => transport.control(...args);
    const checkpoint = (phase, extra) => writeSession(session, phase, extra);
    const save = async (name, result) => {
      const path = resolve(session.folder, `${String(session.seq).padStart(4, '0')}-${name}-${randomUUID().slice(0, 8)}.json`);
      return writeJSON(path, { at: new Date().toISOString(), result });
    };

    if (command === 'prepare' || command === 'run' && !session.runIssued) {
      if (session.pageSessionHash) {
        const settings = await control('rpc', { type: 'settings' });
        assert.equal(settingsHash(settings.settings), session.savedSettingsHash, 'Saved settings changed after preparation');
        const status = await control('displayPlan', { action: 'status' });
        assertStablePageSession(status, session.expectedBuildId, session.pageSessionHash);
        if (status.report?.simulation) assertBodyFreeStatus(status);
        await save('reused-session-status', status);
      } else {
        expected = expected ?? await ensureBuild(session);
        const prepared = await prepareDisplayPlan({ control, expected, checkpoint,
          refreshConnection: async () => { transport.openPage(); await transport.waitHello(30000); } });
        Object.assign(session, { expectedBuildId: expected.buildId, expectedVersion: expected.version,
          sourceHash: expected.sourceHash, savedSettingsHash: prepared.savedSettingsHash,
          pageSessionHash: prepared.pageSessionHash, reloadVerified: true });
        await save('prepared', prepared.prepared);
      }
      if (command === 'prepare') return;
    }

    if (command === 'run') {
      assert.ok(session.expectedBuildId && session.pageSessionHash, 'Prepare the display-plan session first');
      const before = await control('rpc', { type: 'settings' });
      assert.equal(settingsHash(before.settings), session.savedSettingsHash, 'Saved settings changed after preparation');
      await runDisplayPlan({ control, expectedBuildId: session.expectedBuildId,
        expectedSessionHash: session.pageSessionHash, session, checkpoint, save });
      await exportAndSeekDisplayPlan({ control, expectedBuildId: session.expectedBuildId,
        expectedSessionHash: session.pageSessionHash, session, checkpoint, save });
    } else if (command === 'resume') {
      assert.ok(session.expectedBuildId && session.pageSessionHash && session.savedSettingsHash,
        'Display-plan run has no verified preparation');
      const before = await control('rpc', { type: 'settings' });
      assert.equal(settingsHash(before.settings), session.savedSettingsHash, 'Saved settings changed after preparation');
      await resumeDisplayPlan({ control, expectedBuildId: session.expectedBuildId,
        expectedSessionHash: session.pageSessionHash, session, checkpoint, save });
      await exportAndSeekDisplayPlan({ control, expectedBuildId: session.expectedBuildId,
        expectedSessionHash: session.pageSessionHash, session, checkpoint, save });
    } else if (command === 'cleanup') {
      if (!session) session = await createDisplayPlanSession();
      let expectedBuildId = session.expectedBuildId;
      if (!expectedBuildId) expectedBuildId = (await control('rpc', { type: 'build-identity' })).buildId;
      await cleanupDisplayPlan({ control, expectedBuildId, savedSettingsHash: session.savedSettingsHash,
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
