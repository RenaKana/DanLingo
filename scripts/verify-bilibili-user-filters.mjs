// Fixed Bilibili user-filter audit. All provider transports remain guarded throughout a run.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, open, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuildIdentity } from './build-identity.mjs';
import { createBilibiliRunnerTransport } from './bilibili-runner-transport.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = resolve(ROOT, '../DanLingo-Workspace');
const EXTENSION = resolve(WORKSPACE, 'testing/current/extension');
const ARTIFACT = resolve(ROOT, '.artifacts/bilibili-user-filters');
const ROUND = 'regexp-coverage-v1';
const ROUND_ARTIFACT = resolve(ARTIFACT, ROUND);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const optional = async path => readJSON(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const hash = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');

function assertGuard(receipt, expectedBuildId, active = true) {
  assert.equal(receipt?.ok, true, 'User-filter response was not accepted');
  assert.equal(receipt.buildId, expectedBuildId, 'User-filter build changed');
  assert.equal(receipt.background?.buildId, expectedBuildId, 'Background build changed');
  assert.equal(receipt.background.zeroModelGuard, active, 'Zero-model guard state changed');
  assert.equal(receipt.background.actualModelCalls, 0, 'Model call budget violated');
  assert.ok(Number.isSafeInteger(receipt.background.blockedTransports) && receipt.background.blockedTransports >= 0);
}

export async function prepareUserFilters({ control, expected, checkpoint, refreshConnection, sleep = delay }) {
  const saved = await control('rpc', { type: 'settings' });
  assert.equal(saved.settings?.enabled, false, 'Saved translation must be disabled');
  let identity = await control('rpc', { type: 'build-identity' });
  assert.equal(identity.idle, true, 'Background is busy');
  if (identity.buildId !== expected.buildId) {
    await checkpoint('reloading', { savedSettingsHash: hash(saved.settings) });
    await control('reload');
    await sleep(500);
    await refreshConnection();
    identity = await control('rpc', { type: 'build-identity' });
    assert.equal(identity.buildId, expected.buildId, 'Reloaded background build mismatch');
    assert.equal(identity.idle, true, 'Reloaded background is busy');
    assert.equal((await control('rpc', { type: 'settings' })).settings?.enabled, false);
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    await checkpoint('guard-installing', { prepareAttempt: attempt, savedSettingsHash: hash(saved.settings) });
    try {
      const receipt = await control('userFilters', { action: 'prepare' });
      assertGuard(receipt, expected.buildId);
      assert.equal(receipt.enabled, false, 'User-filter feature must start disabled');
      await checkpoint('prepared', { expectedBuildId: expected.buildId, sourceHash: expected.sourceHash,
        savedSettingsHash: hash(saved.settings), prepareAttempt: attempt });
      return receipt;
    } catch (error) {
      if (attempt === 3 || !/TARGET_NAVIGATION_PENDING|USER_FILTERS_PAGE_NOT_READY|watch-not-ready|Receiving end does not exist|Could not establish connection|Timed out: userFilters/i.test(error.message)) throw error;
      await checkpoint('prepare-retrying', { prepareAttempt: attempt, cause: error.message });
      await sleep(500);
    }
  }
}

export async function sampleUserFilters({ control, expectedBuildId, checkpoint, save, sleep = delay }) {
  const before = await control('userFilters', { action: 'status' });
  assertGuard(before, expectedBuildId);
  await save('before-run', before);
  // Record intent before dispatch. A lost response may mean the page already started.
  await checkpoint('run-issuing', { runIssued: true });
  const started = await control('userFilters', { action: 'run' });
  assertGuard(started, expectedBuildId);
  await save('run-started', started);
  await checkpoint('sampling', { runIssued: true });
  return observeUserFilters({ control, expectedBuildId, checkpoint, save, sleep });
}

export async function observeUserFilters({ control, expectedBuildId, checkpoint, save, sleep = delay }) {
  for (let sample = 1; sample <= 4; sample++) {
    await sleep(3000);
    const status = await control('userFilters', { action: 'status' });
    assertGuard(status, expectedBuildId);
    await save(`status-${sample}`, status);
  }
  const final = await control('userFilters', { action: 'status' });
  assertGuard(final, expectedBuildId);
  await save('final-status', final);
  await checkpoint('sampled', { runIssued: true, lastStatusAt: new Date().toISOString() });
  return final;
}

export async function cleanupUserFilters({ control, expectedBuildId, checkpoint, save }) {
  const restored = await control('userFilters', { action: 'cleanup' });
  if (!restored.alreadyClean) {
    assertGuard(restored, expectedBuildId, false);
    assert.equal(restored.report?.restored, true, 'Page restoration unconfirmed');
    assert.equal(typeof restored.enabled, 'boolean', 'Restored user-filter state missing');
    assert.equal(typeof restored.report?.coverage?.featureEnabled, 'boolean', 'Restored coverage state missing');
    assert.equal(restored.enabled, restored.report.coverage.featureEnabled, 'Restored user-filter state mismatch');
  } else {
    assert.equal(restored.background?.zeroModelGuard, false);
    assert.equal(restored.background?.actualModelCalls, 0);
  }
  assert.equal(restored.guardReleased, true, 'Background guard was not released');
  await save('cleanup', restored);
  await checkpoint('guard-released', { restored: true });
  const closed = await control('close-owned');
  await save('closed-owned', closed);
  await checkpoint('cleaned', { restored: true, ownedTargetClosed: closed.closed === true });
  return { restored, closed };
}

async function acquireLock() {
  const path = resolve(ARTIFACT, 'runner.lock');
  try { return await open(path, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = await readJSON(path);
    assert.ok(Number.isSafeInteger(prior.pid) && prior.pid > 0, 'Unrecognized runner lock');
    try { process.kill(prior.pid, 0); throw Error(`Runner process ${prior.pid} still exists`); }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
    await unlink(path);
    return open(path, 'wx');
  }
}

export async function createSession(artifactRoot = ROUND_ARTIFACT, round = ROUND) {
  const id = `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
  const folder = resolve(artifactRoot, id);
  await mkdir(folder);
  return { id, folder, seq: 0, phase: 'created', runIssued: false, ...(round ? { round } : {}) };
}

export async function loadSession(artifactRoot = ROUND_ARTIFACT, expectedRound = ROUND) {
  const pointer = await optional(resolve(artifactRoot, 'active.json'));
  if (!pointer) return null;
  assert.match(pointer.id, /^\d{4}-\d\d-\d\dT[\d-]+Z-[0-9a-f]{8}$/);
  const folder = resolve(artifactRoot, pointer.id);
  assert.equal(basename(folder), pointer.id);
  assert.ok(Number.isSafeInteger(pointer.seq) && pointer.seq >= 1);
  if (expectedRound) assert.equal(pointer.round, expectedRound, 'Active user-filter round mismatch');
  const state = await readJSON(resolve(folder, `checkpoint-${String(pointer.seq).padStart(4, '0')}.json`));
  assert.equal(state.id, pointer.id);
  assert.equal(state.seq, pointer.seq);
  if (expectedRound) assert.equal(state.round, expectedRound, 'Checkpoint user-filter round mismatch');
  return { ...state, folder };
}

export async function writeSession(session, phase, extra = {}) {
  Object.assign(session, extra, { phase, updatedAt: new Date().toISOString(), seq: session.seq + 1 });
  const { folder, ...snapshot } = session;
  const file = resolve(folder, `checkpoint-${String(session.seq).padStart(4, '0')}.json`);
  const fd = await open(file, 'wx');
  try { await fd.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`); }
  finally { await fd.close(); }
  const artifactRoot = dirname(folder);
  const pointer = resolve(artifactRoot, 'active.json');
  const temporary = resolve(artifactRoot, `active-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify({ id: session.id, seq: session.seq, phase,
    ...(session.round ? { round: session.round } : {}) })}\n`);
  await rename(temporary, pointer);
  console.log(JSON.stringify({ phase, directory: folder, ...(session.round ? { round: session.round } : {}), ...extra }));
}

export function resolveUserFilterArtifactRoot(command, legacySession, {
  legacyRoot = ARTIFACT, roundRoot = ROUND_ARTIFACT,
} = {}) {
  if (legacySession && legacySession.phase !== 'cleaned') {
    if (command !== 'cleanup')
      throw Error(`Legacy user-filter run is ${legacySession.phase}; run cleanup before starting ${ROUND}`);
    return legacyRoot;
  }
  return roundRoot;
}

async function save(session, name, result) {
  const file = resolve(session.folder, `${String(session.seq).padStart(4, '0')}-${name}-${randomUUID().slice(0, 8)}.json`);
  const fd = await open(file, 'wx');
  try { await fd.writeFile(`${JSON.stringify({ at: new Date().toISOString(), result }, null, 2)}\n`); }
  finally { await fd.close(); }
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
  await save(session, 'deployed-build', { version: deployed.version, buildId: deployed.buildId,
    builtAt: deployed.builtAt, sourceHash: deployed.sourceHash });
  return deployed;
}

async function main(command) {
  if (command === 'help') {
    console.log('Usage: node scripts/verify-bilibili-user-filters.mjs prepare|run|resume|cleanup');
    return;
  }
  assert.ok(['prepare', 'run', 'resume', 'cleanup'].includes(command), 'Unknown user-filter runner action');
  await mkdir(ARTIFACT, { recursive: true });
  const lock = await acquireLock();
  const transport = createBilibiliRunnerTransport();
  let session;
  let sessionRoot = ROUND_ARTIFACT;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    const legacySession = await loadSession(ARTIFACT, null);
    sessionRoot = resolveUserFilterArtifactRoot(command, legacySession);
    session = sessionRoot === ARTIFACT ? legacySession : await loadSession(ROUND_ARTIFACT, ROUND);
    await mkdir(sessionRoot, { recursive: true });
    if (command === 'resume' && !session) throw Error('No user-filter run to resume');
    if (command === 'resume' && session.phase === 'cleaned') {
      console.log(JSON.stringify({ phase: 'cleaned', directory: session.folder }));
      return;
    }
    if (command === 'resume' && session.phase === 'attention-required' &&
        ['guard-released', 'cleaned'].includes(session.resumePhase))
      throw Error('Cleanup was interrupted; repeat cleanup');
    if (command !== 'cleanup' && command !== 'resume') {
      if (!session || session.phase === 'cleaned') session = await createSession(sessionRoot, ROUND);
      else if (!['created', 'building', 'prepared', 'prepare-retrying', 'guard-installing', 'reloading'].includes(session.phase) &&
          !(session.phase === 'attention-required' && !session.runIssued))
        throw Error('Existing run needs resume or cleanup before starting another');
    }
    const expected = command === 'run' || command === 'prepare' || command === 'resume' && !session.runIssued
      ? await ensureBuild(session) : null;
    await transport.connect();
    const control = (...args) => transport.control(...args);
    const checkpoint = (phase, extra) => writeSession(session, phase, extra);
    const record = (name, value) => save(session, name, value);
    if (command === 'prepare' || command === 'run' || command === 'resume' && !session.runIssued) {
      const receipt = await prepareUserFilters({ control, expected, checkpoint,
        refreshConnection: async () => { transport.openPage(); await transport.waitHello(30000); } });
      await record('prepared', receipt);
    }
    if (command === 'run') await sampleUserFilters({ control, expectedBuildId: expected.buildId, checkpoint, save: record });
    else if (command === 'resume' && !session.runIssued) {
      const status = await control('userFilters', { action: 'status' });
      assertGuard(status, expected.buildId);
      await record('resume-status', status);
    } else if (command === 'resume') {
      assert.ok(session.expectedBuildId, 'Run has no verified build identity');
      if (session.runIssued && session.phase !== 'sampled' && session.phase !== 'cleaned' &&
          session.resumePhase !== 'sampled')
        await observeUserFilters({ control, expectedBuildId: session.expectedBuildId, checkpoint, save: record });
      else {
        const status = await control('userFilters', { action: 'status' });
        assertGuard(status, session.expectedBuildId, session.phase !== 'cleaned');
        await record('resume-status', status);
      }
    } else if (command === 'cleanup') {
      if (!session) session = await createSession(sessionRoot, ROUND);
      const background = await control('rpc', { type: 'build-identity' });
      await cleanupUserFilters({ control, expectedBuildId: session.expectedBuildId ?? background.buildId,
        checkpoint, save: record });
      const settingsAfter = await control('rpc', { type: 'settings' });
      await record('settings-restoration', { savedSettingsUnchanged: session.savedSettingsHash
        ? hash(settingsAfter.settings) === session.savedSettingsHash : null });
    }
  } catch (error) {
    const redacted = transport.redact(error.message);
    if (session) await writeSession(session, 'attention-required', { error: redacted, resumePhase: session.phase });
    else console.error(redacted);
    process.exitCode = 1;
  } finally {
    await transport.close();
    await lock.close();
    await unlink(resolve(ARTIFACT, 'runner.lock'));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv[2] ?? 'help');
