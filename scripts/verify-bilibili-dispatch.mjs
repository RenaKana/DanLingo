// Fixed task controller: authenticated loopback commands, never arbitrary page code or personal-profile CDP.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, open, unlink, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createBuildIdentity } from './build-identity.mjs';
import { createLedger, loadLedger, getLedgerUsage, reserveSegment, settleSegment, writeJSON } from './bilibili-dispatch-ledger.mjs';
import { createBilibiliRunnerTransport } from './bilibili-runner-transport.mjs';
export { consumeCommandResult } from './bilibili-runner-transport.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = resolve(ROOT, '../DanLingo-Workspace');
const ARTIFACT = resolve(ROOT, '.artifacts/bilibili-pretranslation-audit/dispatch-runner-20260926');
const EXTENSION = resolve(WORKSPACE, 'testing/current/extension');
const [command = 'help'] = process.argv.slice(2);
const hash = x => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const optional = async path => readJSON(path).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
const save = (name, value) => writeJSON(resolve(ARTIFACT, name), value);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const transport = createBilibiliRunnerTransport();
let lock, ledger, state, expected, activeSegment;
async function acquireLock() {
  const path = resolve(ARTIFACT, 'runner.lock');
  try { return await open(path, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = await readJSON(path);
    assert.ok(Number.isSafeInteger(previous.pid) && previous.pid > 0, 'Unrecognized runner lock; not removed');
    try { process.kill(previous.pid, 0); throw Error(`Runner process ${previous.pid} still exists; do not start another run`); }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
    // Only this runner's lock, after the recorded process has been proved absent.
    await unlink(path); return open(path, 'wx');
  }
}

async function checkpoint(phase, extra = {}) {
  state = { ...state, ...extra, phase, updatedAt: new Date().toISOString(), usage: getLedgerUsage(ledger) };
  await save('checkpoint.json', state);
  console.log(JSON.stringify({ phase, usage: state.usage, ...extra }));
}
async function until(test, label, timeout = 30000) {
  const end = Date.now() + timeout;
  do { const result = await test(); if (result) return result; await delay(200); } while (Date.now() < end);
  throw new Error(`Timed out: ${label}`);
}
async function connect() {
  const hello = await transport.connect();
  await save('connection.json', { at: new Date().toISOString(), extensionId: hello.extensionId, version: hello.version,
    transport: 'authenticated exact commands on 127.0.0.1', credentialsExported: false });
}
const control = (...args) => transport.control(...args);
const rpc = message => control('rpc', message);
const audit = (action, args = {}) => control('audit', { action, args });
async function waitForAudit() {
  return until(async () => {
    try { return await audit('status'); }
    catch (error) {
      if (/TARGET_NAVIGATION_PENDING|AUDIT_NOT_READY|Receiving end does not exist|Could not establish connection|播放器尚未适配/i.test(error.message)) return null;
      throw error;
    }
  }, 'target diagnostic connection', 30000);
}
async function idle() {
  const result = await rpc({ type: 'local-control', control: { action: 'state' } });
  assert.ok(result.ok, result.error); assert.equal(result.state.active, 0, 'Local workload is busy');
  assert.equal(result.state.queued, 0, 'Local queue is busy'); return result.state;
}
async function ensureBuild() {
  const deployed = await optional(resolve(EXTENSION, 'runtime-identity.json'));
  if (!deployed || deployed.sourceHash !== createBuildIdentity(ROOT).sourceHash) {
    assert.equal(ledger.segments.length, 0, 'Build frozen after first formal start');
    await checkpoint('building');
    const tests = ['test/core/bilibili-audit.test.mjs','test/core/bilibili-local-experiment.test.mjs',
      'test/core/bilibili-experiment-watch.test.mjs','test/core/bilibili-experiment-native.test.mjs',
      'test/core/bilibili-shadow-observer.test.mjs','test/core/bilibili-weight-shadow.test.mjs',
      'test/core/bilibili-video.test.mjs','test/core/navigation.test.mjs','test/core/dispatch-runner-protocol.test.mjs',
      'test/core/bilibili-dispatch-runner.test.mjs',
      'scripts/bilibili-dispatch-ledger.test.mjs','scripts/bilibili-dispatch-analysis.test.mjs','scripts/build-identity.test.mjs',
      'scripts/verify-bilibili-dispatch.test.mjs'];
    const q = x => `'${x.replaceAll("'", "''")}'`;
    await writeFile(resolve(ARTIFACT, 'update.ps1'), `$ErrorActionPreference='Stop'\n& ${q(resolve(WORKSPACE,'tools/Update-TestBuild.ps1'))} -RegressionTests @(${tests.map(q).join(',')})\nexit $LASTEXITCODE\n`);
    const log = await open(resolve(ARTIFACT, 'build.log'), 'a');
    try { await new Promise((yes, no) => { const child = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve(ARTIFACT,'update.ps1')],
      { cwd: ROOT, windowsHide: true, stdio: ['ignore',log.fd,log.fd] }); child.on('error', no); child.on('exit', code => code === 0 ? yes() : no(Error(`Updater failed (${code}); see build.log`))); }); }
    finally { await log.close(); }
  }
  expected = await readJSON(resolve(EXTENSION, 'runtime-identity.json'));
  assert.equal(expected.sourceHash, createBuildIdentity(ROOT).sourceHash, 'Source changed during build');
}
async function prepareOnce() {
  const saved = (await rpc({ type: 'settings' })).settings;
  assert.equal(saved.enabled, false); assert.equal(saved.backend, 'local'); assert.equal(saved.sourceLanguage, 'auto');
  assert.equal(saved.targetLanguage, 'ja'); assert.equal(saved.concurrency, 2);
  const configFingerprint = hash(saved);
  if (ledger.segments.length) assert.equal(configFingerprint, state.configFingerprint, 'Formal configuration changed');
  await idle();
  let identity = await rpc({ type: 'build-identity' });
  if (identity.buildId !== expected.buildId || !state.reloadVerified) {
    assert.equal(ledger.segments.length, 0, 'Cannot reload a formal pair');
    assert.equal(identity.idle, true, 'Background has another active workload; reload refused');
    await checkpoint('reloading', { configFingerprint }); await control('reload'); state.refreshAfterReload = true;
    await delay(500); transport.openPage(); await transport.waitHello(30000);
    identity = await rpc({ type: 'build-identity' });
    assert.equal(identity.buildId, expected.buildId); state.reloadVerified = true;
  }
  assert.equal(identity.buildId, expected.buildId, 'Loaded background mismatch');
  await control('openTarget', state.refreshAfterReload ? { refresh: true } : {});
  state.refreshAfterReload = false;
  await waitForAudit();
  const receipt = await audit('prepare');
  assert.equal(receipt.buildId, expected.buildId, 'Diagnostic content build mismatch');
  assert.ok(receipt.configurationProbe?.apply?.ok && receipt.configurationProbe?.stop?.ok, 'Configuration application/restoration not verified');
  await save(`prepare-${(state.prepareCount ?? 0) + 1}-receipt.json`, { expected, background: identity, receipt, configFingerprint });
  if (!state.zeroVerified || state.buildId !== expected.buildId) {
    const before = await idle(); await audit('zero-start'); await audit('play');
    const playbackSamples = [];
    try {
      await until(async () => {
        const observed = await audit('status');
        playbackSamples.push({ at: new Date().toISOString(), videoTimeMs: observed.videoTimeMs,
          paused: observed.paused, seeking: observed.seeking, active: observed.active, stopped: observed.stopped });
        return observed.stopped;
      }, 'zero-call 52-67 interval', 25000);
    } finally { await save(`zero-playback-status-${Date.now()}.json`, { playbackSamples }); }
    await audit('stop'); const raw = (await audit('export')).data; const after = await idle();
    assert.equal(after.inferenceCalls, before.inferenceCalls); assert.equal(raw.ended?.reason, 'interval-complete');
    assert.equal(raw.localExperiment ?? null, null);
    assert.equal(raw.runnerEvidence?.environment?.status, 'stable', 'Zero-call playback conditions were not stable');
    await save('zero-call-real.json', raw); await audit('restore'); state.zeroVerified = true;
    state.zeroPrepareSignature = receipt.runnerEvidence?.prepareEnvironment?.signature;
  }
  const local = await idle(), listed = await rpc({ type: 'local-control', control: { action: 'list' } });
  assert.ok(listed.ok && listed.models?.some(m => m.id === saved.localModelId), 'Selected model registration unavailable');
  assert.ok(['idle','ready'].includes(local.phase), 'Another model workload or model error needs attention');
  if (local.phase !== 'ready') await checkpoint('loading-selected-model');
  // This checked entry also verifies an already loaded model's configuration.
  const loaded = await rpc({ type: 'local-control', control: { action: 'load', modelId: saved.localModelId } });
  assert.ok(loaded.ok, loaded.error);
  if (!loaded.alreadyReady) assert.equal(loaded.state.inferenceCalls, 0, 'Model loading unexpectedly performed inference');
  const ready = await idle(); assert.equal(ready.model?.id, saved.localModelId); assert.equal(ready.phase, 'ready');
  const prepared = await audit('prepare'); assert.equal(hash((await rpc({ type: 'settings' })).settings), configFingerprint);
  const modelFingerprint = prepared.runnerEvidence?.modelFingerprint;
  const prepareEnvironmentSignature = prepared.runnerEvidence?.prepareEnvironment?.signature;
  assert.ok(typeof modelFingerprint === 'string' && modelFingerprint, 'Loaded model fingerprint missing');
  assert.ok(typeof prepareEnvironmentSignature === 'string' && prepareEnvironmentSignature, 'Prepared environment fingerprint missing');
  assert.equal(prepareEnvironmentSignature, state.zeroPrepareSignature, 'Environment no longer matches zero-call playback');
  if (ledger.segments.length) assert.equal(modelFingerprint, state.modelFingerprint, 'Formal model fingerprint changed');
  await save(`prepare-${(state.prepareCount ?? 0) + 1}-ready.json`, { identity, expected, configFingerprint, prepared,
    modelPreparation: { alreadyReady: !!loaded.alreadyReady, warmupSuppressed: loaded.warmupSuppressed,
      inferenceCalls: ready.inferenceCalls },
    local: { phase: ready.phase, modelId: ready.model.id, generation: ready.generation, active: ready.active, queued: ready.queued } });
  await checkpoint('prepared', { buildId: expected.buildId, configFingerprint, prepareCount: (state.prepareCount ?? 0) + 1,
    reloadVerified: true, zeroVerified: true, modelFingerprint, prepareEnvironmentSignature,
    zeroPrepareSignature: state.zeroPrepareSignature });
}
async function prepare() {
  for (;;) try { return await prepareOnce(); }
  catch (e) {
    if (ledger.segments.length || state.zeroRecoveryRounds >= 3 || !/Timed out|connection|scope-not-ready|preview-required/i.test(e.message)) throw e;
    await checkpoint('zero-call-environment-recovery', { zeroRecoveryRounds: (state.zeroRecoveryRounds ?? 0) + 1, cause: e.message });
    const stopped = await audit('stop');
    if (stopped.hasCapture) await save(`zero-recovery-${state.zeroRecoveryRounds}-capture.json`, (await audit('export')).data);
    await audit('restore'); await control('openTarget', { refresh: true });
    await waitForAudit();
  }
}
export function classifySegment(segment, raw) {
  const r = raw.localExperiment?.report, d = raw.localExperiment?.dispatch;
  assert.ok(r && d, 'No actual experiment report');
  const packetSizes = Object.keys(d.rawPacketSizes ?? {}).map(Number);
  const environmentInvalid = raw.ended?.reason !== 'interval-complete' || raw.runnerEvidence?.environment?.status !== 'stable';
  const badPolicy = d.singleDispatch !== (segment.group === 'B') || d.concurrency !== 2 || d.peakRequests > 2 ||
    (segment.group === 'B' && packetSizes.some(size => size !== 1));
  const nativeChanged = raw.runnerEvidence?.environment?.changes?.some(change => change.field === 'native');
  const safetyViolation = r.safety && (r.safety.savedSettingsWrites !== 0 || r.safety.persistentCacheWrites !== 0 || r.safety.modelLoads !== 0);
  const hard = !!d.violationReason || raw.ended?.reason === 'rule-conflict' || badPolicy || !!raw.diagnosticError || nativeChanged || safetyViolation;
  // No packets after a failed playback start is an environmental failure, not
  // evidence of a broken dispatch policy. A normally ended but unobserved
  // policy remains a hard stop; another sample is not authorized for that.
  const status = hard ? 'hard-failure' : environmentInvalid ? 'environment-invalid' : !packetSizes.length ? 'hard-failure' : 'completed';
  return { status, reason: status === 'completed' ? null : hard ? 'dispatch-or-native-rule-conflict' :
    environmentInvalid ? 'playback-state-changed' : 'dispatch-policy-unobserved' };
}
async function settle(segment, raw, name) {
  const r = raw.localExperiment?.report; assert.ok(r, 'No actual experiment report');
  assert.equal(r.runId, state.experimentRunId, 'Raw export is not the reserved experiment');
  const text = JSON.stringify(raw, null, 2), rawPath = resolve(ARTIFACT, name); await writeFile(rawPath, text, { flag: 'wx' });
  assert.ok(['providerCalls','sentInputItems','sentInputChars'].every(key => Number.isSafeInteger(r[key]) && r[key] >= 0), 'Actual request accounting missing');
  assert.ok(Array.isArray(r.providerAttempts) && r.providerAttempts.length === r.providerCalls, 'Actual request attempts mismatch');
  assert.equal(hash((await rpc({ type: 'settings' })).settings), state.configFingerprint, 'Formal configuration changed during playback');
  const after = await until(async () => {
    const result = await rpc({ type: 'local-control', control: { action: 'state' } });
    return result.state?.active === 0 && result.state?.queued === 0 ? result.state : null;
  }, 'owned experiment request cancellation', 15000);
  if (state.localBeforeSegment) {
    assert.equal(after.generation, state.localBeforeSegment.generation, 'Model generation changed');
    const delta = after.inferenceCalls - state.localBeforeSegment.inferenceCalls;
    assert.ok(Number.isSafeInteger(delta) && delta >= 0 && delta <= r.providerCalls, 'Unaccounted model inference');
    await save(`${segment.id}-runtime-accounting.json`, { before: state.localBeforeSegment,
      after: { generation: after.generation, inferenceCalls: after.inferenceCalls, active: after.active, queued: after.queued },
      runtimeInferenceDelta: delta, countedAtLocalFetchBoundary: r.providerCalls });
  }
  let classification = classifySegment(segment, raw);
  if (segment.group === 'A' && classification.status === 'completed') {
    const completedB = ledger.segments.findLast(item => item.group === 'B' && item.status === 'completed');
    assert.ok(completedB?.rawPath, 'A has no completed B baseline');
    const baseline = await readJSON(completedB.rawPath);
    const evidence = raw.runnerEvidence, previous = baseline.runnerEvidence;
    if (!evidence?.modelFingerprint || evidence.modelFingerprint !== previous?.modelFingerprint ||
        evidence.buildId !== previous?.buildId || raw.shadowContract?.sha256 !== baseline.shadowContract?.sha256)
      classification = { status: 'hard-failure', reason: 'model-build-or-native-contract-changed' };
    else if (hash(evidence.environment.signature) !== hash(previous.environment.signature))
      classification = { status: 'environment-invalid', reason: 'viewport-state-changed' };
  }
  const result = settleSegment(ledger, segment.id, { ...classification,
    providerCalls: r.providerCalls, sentInputItems: r.sentInputItems, sentInputChars: r.sentInputChars,
    cancelled: r.providerAttempts.filter(a => a.reason === 'cancelled').length, rawPath, rawSha256: hash(text) });
  ledger = result.ledger; await save('ledger.json', ledger); activeSegment = null; return result.segment;
}
async function recover() {
  const last = ledger.segments.at(-1); if (last?.status !== 'reserved') return;
  await control('openTarget'); await waitForAudit(); await audit('stop'); let raw;
  try { raw = (await audit('export')).data; } catch { /* Unknown counts retain the entire 55-call reservation. */ }
  if (raw?.localExperiment?.report?.runId === state.experimentRunId) await settle(last, raw, `${last.id}-recovered-real.json`);
  else { ledger = settleSegment(ledger, last.id, { status: 'environment-invalid', reason: 'temporary-connection' }).ledger; await save('ledger.json', ledger); }
  await checkpoint('recovered');
}
async function run() {
  await recover(); await prepare(); if ((state.prepareCount ?? 0) < 2) await prepare();
  for (;;) {
    const last = ledger.segments.at(-1); if (last?.status === 'hard-failure') throw Error('Hard failure: no retry authorized');
    if (last?.group === 'A' && last.status === 'completed') break;
    const group = !last || last.status === 'environment-invalid' ? last?.group ?? 'B' : 'A';
    const receipt = await audit('prepare'); const before = await idle();
    assert.equal(receipt.buildId, expected.buildId, 'Formal content build changed');
    assert.equal(receipt.runnerEvidence?.modelFingerprint, state.modelFingerprint, 'Formal model fingerprint changed');
    assert.equal(receipt.runnerEvidence?.prepareEnvironment?.signature, state.prepareEnvironmentSignature, 'Formal environment differs from zero-call playback');
    assert.equal(hash((await rpc({ type: 'settings' })).settings), state.configFingerprint, 'Formal configuration changed');
    const reserved = reserveSegment(ledger, { group, buildId: expected.buildId, configFingerprint: state.configFingerprint,
      ...(last?.status === 'environment-invalid' ? { reason: 'playback-state-changed' } : {}) });
    ledger = reserved.ledger; activeSegment = reserved.segment; await save('ledger.json', ledger);
    await checkpoint(`reserved-${group}`, { experimentRunId: null, activeSegmentId: reserved.segment.id,
      localBeforeSegment: { generation: before.generation, inferenceCalls: before.inferenceCalls } });
    const started = await audit(group === 'B' ? 'start-B' : 'start-A');
    await checkpoint(`running-${group}`, { experimentRunId: started.localRun?.runId ?? started.runId });
    await audit('play'); await until(async () => (await audit('status')).stopped, 'formal 52-67 interval', 25000);
    await audit('stop'); const settled = await settle(reserved.segment, (await audit('export')).data, `${reserved.segment.id}-${group}-real.json`);
    await audit('restore'); await idle(); await checkpoint(`recorded-${group}`);
    if (settled.reason === 'viewport-state-changed') throw Error('A environment differs from B; restore the recorded B viewport before resume');
  }
  const a = ledger.segments.findLast(x => x.group === 'A' && x.status === 'completed');
  const b = ledger.segments.findLast(x => x.group === 'B' && x.status === 'completed');
  assert.equal(a.buildId,b.buildId); assert.equal(a.configFingerprint,b.configFingerprint);
  const { compare } = await import('./bilibili-dispatch-analysis.mjs');
  const analysis = compare(await readJSON(a.rawPath),await readJSON(b.rawPath));
  await save('pair-analysis.json', analysis);
  await checkpoint('analysis-complete', { validForPolicyEvaluation: analysis.strategy.validForPolicyEvaluation,
    strategyFinding: analysis.strategy.finding });
}
async function cleanup() {
  await recover();
  let stopped, restored;
  try {
    stopped = await audit('stop');
    if (stopped.hasCapture) await save(`cleanup-capture-${Date.now()}.json`, (await audit('export')).data);
    restored = await audit('restore');
  }
  catch (error) {
    if (error.message === 'OWNED_TARGET_UNAVAILABLE') restored = { ok: true, noOwnedTarget: true };
    else {
      if (!/AUDIT_NOT_READY|Receiving end does not exist|Could not establish connection/i.test(error.message)) throw error;
      // A reloaded extension cannot reach invalidated content listeners. With
      // both engines idle, closing only our owned tab removes that stale page
      // and its hooks without pretending to have received a restore ack.
      await idle();
      assert.equal((await rpc({ type: 'build-identity' })).idle, true, 'Background is busy; stale target kept');
      const closed = await control('close-owned');
      assert.equal(closed.closed, true, 'Stale owned target closure unconfirmed');
      restored = { ok: true, staleOwnedTargetClosed: true, pageRestoreAck: false, hooksRemovedWithOwnedDocument: true };
    }
  }
  assert.equal(restored.ok, true, 'Temporary state restoration not confirmed');
  const local = await idle();
  const unchanged = !state.configFingerprint || hash((await rpc({ type: 'settings' })).settings) === state.configFingerprint;
  await save('cleanup.json', { at: new Date().toISOString(), local: { active: local.active, queued: local.queued }, restored,
    stopped, savedSettingsUnchanged: unchanged, usage: getLedgerUsage(ledger), userBrowserProcessesClosed: 0 });
  assert.ok(unchanged, 'External settings changed; not overwritten'); await control('close-owned');
}
async function main() {
if (command === 'help') console.log('Usage: node scripts/verify-bilibili-dispatch.mjs prepare|run|resume|cleanup');
else {
  assert.ok(['prepare','run','resume','cleanup'].includes(command)); await mkdir(ARTIFACT,{recursive:true});
  try {
    lock = await acquireLock(); await lock.writeFile(JSON.stringify({pid:process.pid}));
    ledger = await loadLedger(resolve(ARTIFACT,'ledger.json')).catch(e => { if(e.code==='ENOENT')return createLedger();throw e; });
    await save('ledger.json',ledger); const previous = await optional(resolve(ARTIFACT,'checkpoint.json'));
    state = previous?.runId ? previous : { runId: randomUUID(), prepareCount:0, zeroRecoveryRounds:0 };
    if(command!=='cleanup')await ensureBuild(); await connect();
    if(command==='prepare')await prepare(); else if(command==='cleanup')await cleanup(); else {await run();await cleanup();}
  } catch(e) {
    const error = transport.redact(e.message);
    if (transport.hello && activeSegment) {
      try {
        await audit('stop'); const raw = (await audit('export')).data;
        if (state.experimentRunId && raw?.localExperiment?.report?.runId === state.experimentRunId)
          await settle(activeSegment, raw, `${activeSegment.id}-interrupted-real.json`);
        await audit('restore');
      } catch (cleanupError) { await save('interrupted-cleanup.json', { error: transport.redact(cleanupError.message),
        countsRemainReserved: true, usage: getLedgerUsage(ledger) }); }
    } else if (transport.hello && command !== 'cleanup') {
      try { await cleanup(); }
      catch (cleanupError) { await save('preflight-cleanup-error.json', {
        error: transport.redact(cleanupError.message), usage: getLedgerUsage(ledger) }); }
    }
    if(ledger)await checkpoint('attention-required',{error,nextCommand:`node scripts/verify-bilibili-dispatch.mjs ${activeSegment?'resume':command}`});
    else console.error(error); process.exitCode=1;
  } finally {
    await transport.close();
    if(lock){await lock.close();await unlink(resolve(ARTIFACT,'runner.lock'));}
  }
}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
