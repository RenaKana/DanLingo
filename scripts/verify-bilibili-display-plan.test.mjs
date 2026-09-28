import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DISPLAY_PLAN_DURATION_MS, DISPLAY_PLAN_SAMPLE_INTERVAL_MS, settingsHash,
  prepareDisplayPlan, runDisplayPlan, resumeDisplayPlan, exportAndSeekDisplayPlan,
  cleanupDisplayPlan, measurePlaybackWindow, pageSessionHash, assertStablePageSession,
} from './verify-bilibili-display-plan.mjs';

const expected = { buildId: '0.4.18-test', version: '0.4.18', sourceHash: 'source' };
const pageSession = { platform: 'bilibili', scenario: 'video', resourceId: 'video-session',
  urlResourceId: 'BV1-test', sessionId: 'document-session', generation: 1 };
const baseSimulation = (patch = {}) => ({ evidence: 'display-plan-memory-provider-only', stopped: false,
  stopReason: '', limits: { inputFrames: 1000, inputBytes: 8 * 1024 * 1024, sourcePool: 20000, sideRecords: 40000 },
  inputFrameCount: 0, inputBytes: 0, inputTruncated: false, inputFrames: undefined,
  A: { events: [], truncation: { events: 0 }, providerInputLog: [] },
  B: { events: [], truncation: { events: 0 }, providerInputLog: [] }, ...patch });
const receipt = (action, patch = {}) => ({ ok: true, version: expected.version, buildId: expected.buildId,
  session: pageSession, background: { buildId: expected.buildId, idle: true,
    zeroModelGuard: action !== 'cleanup', actualModelCalls: 0, blockedTransports: 0 },
  guardReleased: action === 'cleanup',
  report: { coverage: { mainBuildId: expected.buildId },
    simulation: action === 'prepare' ? null : baseSimulation(), playback: { seekCount: action === 'seek' ? 1 : 0,
      restored: action === 'cleanup' }, restored: action === 'cleanup',
    actualModelCalls: 0, modelLoads: 0, nativeSettingsWrites: 0 }, ...patch });

function playbackSimulation({ pausedDuring = false, epochs = [4] } = {}) {
  const inputFrames = [{ resourceId: 'video-session', epoch: epochs[0], wallTimeMs: 0,
    mediaTimeMs: 1000, playbackRate: 1, paused: true, seeking: false }];
  for (let wallTimeMs = 100; wallTimeMs <= 35100; wallTimeMs += 2500) {
    inputFrames.push({ resourceId: 'video-session', epoch: epochs[0], wallTimeMs,
      mediaTimeMs: 1000 + wallTimeMs, playbackRate: 1,
      paused: pausedDuring && wallTimeMs === 15100, seeking: false });
  }
  if (epochs.length > 1) inputFrames.at(-1).epoch = epochs.at(-1);
  const sim = baseSimulation({ inputFrames, inputFrameCount: inputFrames.length, inputBytes: 1000 });
  return sim;
}

function fixtureHarness({ now = 1000, settings = { enabled: false, targetLanguage: 'ja' },
  simulation = baseSimulation() } = {}) {
  const calls = [], phases = [], files = new Map();
  let time = now, seekCount = 0, exportCount = 0, saveCount = 0;
  const advance = ms => { time += ms; };
  const control = async (command, payload = {}) => {
    calls.push(`${command}:${payload?.type ?? payload?.action ?? ''}`);
    if (command === 'rpc' && payload.type === 'settings') return { settings };
    if (command === 'rpc' && payload.type === 'build-identity')
      return { version: expected.version, buildId: expected.buildId, idle: true };
    if (command === 'reload') return { willReload: true };
    if (command === 'displayPlan') {
      const currentSession = { ...pageSession, generation: seekCount ? 2 : 1 };
      if (payload.action === 'export') {
        exportCount++;
        return receipt('export', { session: currentSession, report: { ...receipt('export').report,
          simulation: playbackSimulation(), playback: { seekCount, restored: false } } });
      }
      if (payload.action === 'seek') { seekCount++; return receipt('seek', { session: { ...pageSession, generation: 2 }, report: { ...receipt('seek').report,
        simulation, playback: { seekCount, restored: false } } }); }
      const result = receipt(payload.action, { session: currentSession, report: { ...receipt(payload.action).report,
        simulation: payload.action === 'prepare' ? null : simulation, playback: { seekCount, restored: false } } });
      return result;
    }
    if (command === 'close-owned') return { closed: true };
    throw Error(`Unexpected command ${command}`);
  };
  const checkpoint = async (phase, extra = {}) => { phases.push(phase); Object.assign(state, extra, { phase }); };
  const state = { runIssued: false };
  const save = async (name, value) => { const path = `${++saveCount}-${name}.json`; files.set(path, { result: value }); return path; };
  const read = async path => files.get(path);
  return { calls, phases, state, files, control, checkpoint, save, read,
    now: () => time, advance, setTime: value => { time = value; },
    sleep: async ms => advance(ms), get seekCount() { return seekCount; }, get exportCount() { return exportCount; } };
}

test('prepare checks disabled settings and idle matching build before one guarded page action', async () => {
  const h = fixtureHarness();
  const prepared = await prepareDisplayPlan({ control: h.control, expected,
    checkpoint: h.checkpoint, refreshConnection: async () => h.calls.push('reconnect'), sleep: async () => {} });
  assert.equal(prepared.savedSettingsHash, settingsHash({ enabled: false, targetLanguage: 'ja' }));
  assert.equal(h.state.phase, 'prepared');
  assert.deepEqual(h.calls, ['rpc:settings', 'rpc:build-identity', 'rpc:settings', 'displayPlan:prepare']);
  const denied = fixtureHarness({ settings: { enabled: true } });
  await assert.rejects(prepareDisplayPlan({ control: denied.control, expected,
    checkpoint: denied.checkpoint, refreshConnection: async () => {} }), /must be disabled/);
  assert.equal(denied.calls.some(call => call === 'displayPlan:prepare'), false);
});

test('run is issued once, samples every 3 seconds through 35 seconds, and does not export by itself', async () => {
  const h = fixtureHarness();
  h.state.pageSessionHash = pageSessionHash(pageSession);
  const result = await runDisplayPlan({ control: h.control, expectedBuildId: expected.buildId,
    expectedSessionHash: h.state.pageSessionHash, session: h.state,
    checkpoint: h.checkpoint, save: h.save, now: h.now, sleep: h.sleep });
  assert.equal(result.sampleDeadlineAt, 1000 + DISPLAY_PLAN_DURATION_MS);
  assert.equal(result.sampleCount, 12);
  assert.equal(h.calls.filter(call => call === 'displayPlan:run').length, 1);
  assert.equal(h.calls.filter(call => call === 'displayPlan:status').length, 12);
  assert.equal(h.calls.some(call => call === 'displayPlan:export'), false);
  assert.equal(h.calls.some(call => call === 'displayPlan:seek'), false);
  assert.equal(h.calls.at(-1), 'displayPlan:status');
  assert.equal(h.state.phase, 'sample-window-elapsed');
  assert.equal(DISPLAY_PLAN_SAMPLE_INTERVAL_MS, 3000);
  await assert.rejects(runDisplayPlan({ control: h.control, expectedBuildId: expected.buildId,
    expectedSessionHash: h.state.pageSessionHash, session: h.state,
    checkpoint: h.checkpoint, save: h.save, now: h.now, sleep: h.sleep }), /only be issued once/);
});

test('resume observes an existing run by status only and never replays it', async () => {
  const h = fixtureHarness({ now: 10000 });
  h.state.runIssued = true; h.state.sampleStartedAt = 1000;
  h.state.pageSessionHash = pageSessionHash(pageSession);
  const result = await resumeDisplayPlan({ control: h.control, expectedBuildId: expected.buildId,
    expectedSessionHash: h.state.pageSessionHash, session: h.state,
    checkpoint: h.checkpoint, save: h.save, now: h.now, sleep: h.sleep });
  assert.equal(result.resumed, true);
  assert.equal(h.calls.some(call => call === 'displayPlan:run'), false);
  assert.ok(h.calls.every(call => call === 'displayPlan:status'));
  assert.ok(h.calls.length > 1);
});

test('input trace truncation stops sampling and permanently blocks resume', async () => {
  let statusCalls = 0;
  const h = fixtureHarness();
  h.state.pageSessionHash = pageSessionHash(pageSession);
  const control = async (command, payload) => {
    if (command === 'displayPlan' && payload.action === 'status') {
      statusCalls++;
      return receipt('status', { report: { ...receipt('status').report,
        simulation: baseSimulation({ inputTruncated: true, stopReason: 'input-trace-budget-exhausted' }) } });
    }
    return h.control(command, payload);
  };
  await assert.rejects(runDisplayPlan({ control, expectedBuildId: expected.buildId,
    expectedSessionHash: h.state.pageSessionHash, session: h.state,
    checkpoint: h.checkpoint, save: h.save, now: h.now, sleep: h.sleep }), /CLEANUP_REQUIRED/);
  assert.equal(statusCalls, 1);
  assert.equal(h.state.traceExhausted, true);
  await assert.rejects(resumeDisplayPlan({ control, expectedBuildId: expected.buildId,
    expectedSessionHash: h.state.pageSessionHash, session: h.state,
    checkpoint: h.checkpoint, save: h.save, now: h.now, sleep: h.sleep }), /TRACE_EXHAUSTED/);
  assert.equal(statusCalls, 1);
});

test('explicit run export proves 30-40 seconds of one 1x epoch, seeks once, then exports and analyzes again', async () => {
  const h = fixtureHarness();
  h.state.pageSessionHash = pageSessionHash(pageSession);
  h.state.runIssued = true;
  h.state.sampleStartedAt = 1000;
  h.state.runReceiptPath = await h.save('run-started', receipt('run'));
  const result = await exportAndSeekDisplayPlan({ control: h.control,
    expectedBuildId: expected.buildId, expectedSessionHash: h.state.pageSessionHash,
    session: h.state, checkpoint: h.checkpoint, save: h.save, read: h.read,
    sleep: h.sleep, analyze: () => ({ ok: true, violations: [] }) });
  assert.equal(result.analysis.ok, true);
  assert.equal(h.seekCount, 1);
  assert.equal(h.exportCount, 2);
  assert.equal(h.state.playbackWindow.mediaDurationMs, 35000);
  assert.equal(h.state.playbackWindow.startupFrameCount, 1);
  assert.ok(h.state.runReceiptPath && h.state.seekReceiptPath && h.state.preSeekExportPath && h.state.finalExportPath);
  const callsBeforeResume = [...h.calls];
  h.setTime(1000 + DISPLAY_PLAN_DURATION_MS + 2000);
  const resumed = await resumeDisplayPlan({ control: h.control, expectedBuildId: expected.buildId,
    expectedSessionHash: h.state.pageSessionHash, session: h.state,
    checkpoint: h.checkpoint, save: h.save, now: h.now, sleep: h.sleep });
  assert.equal(resumed.resumed, true);
  const reused = await exportAndSeekDisplayPlan({ control: h.control,
    expectedBuildId: expected.buildId, expectedSessionHash: h.state.pageSessionHash,
    session: h.state, checkpoint: h.checkpoint, save: h.save, read: h.read,
    sleep: h.sleep, analyze: () => assert.fail('completed resume must reuse saved analysis') });
  assert.equal(reused.reused, true);
  assert.deepEqual(h.calls.slice(callsBeforeResume.length), ['displayPlan:status'],
    'completed resume reads status and saved evidence without another seek/export');
  const paused = playbackSimulation({ pausedDuring: true });
  assert.throws(() => measurePlaybackWindow(paused), /paused during the sample/);
  assert.throws(() => measurePlaybackWindow(playbackSimulation({ epochs: [4, 5] })), /resource or epoch boundary/);
});

test('cleanup restores, releases, closes, and verifies settings in order; a retry skips completed steps', async () => {
  const h = fixtureHarness();
  const baseline = settingsHash({ enabled: false, targetLanguage: 'ja' });
  h.state.savedSettingsHash = baseline;
  const result = await cleanupDisplayPlan({ control: h.control, expectedBuildId: expected.buildId,
    savedSettingsHash: baseline, session: h.state, checkpoint: h.checkpoint, save: h.save, read: h.read });
  assert.equal(result.savedSettingsUnchanged, true);
  assert.deepEqual(h.calls, ['displayPlan:cleanup', 'close-owned:', 'rpc:settings']);
  assert.equal(h.state.phase, 'cleaned');

  const interrupted = fixtureHarness();
  interrupted.state.savedSettingsHash = baseline;
  let closeCalls = 0;
  const once = async (command, payload) => {
    if (command === 'close-owned' && closeCalls++ === 0) throw Error('closed-response-lost');
    if (command === 'close-owned') return { closed: false };
    return interrupted.control(command, payload);
  };
  await assert.rejects(cleanupDisplayPlan({ control: once, expectedBuildId: expected.buildId,
    savedSettingsHash: baseline, session: interrupted.state, checkpoint: interrupted.checkpoint,
    save: interrupted.save, read: interrupted.read }), /closed-response-lost/);
  assert.equal(interrupted.state.guardReleased, true);
  const retried = await cleanupDisplayPlan({ control: once, expectedBuildId: expected.buildId,
    savedSettingsHash: baseline, session: interrupted.state, checkpoint: interrupted.checkpoint,
    save: interrupted.save, read: interrupted.read });
  assert.equal(retried.closed.closed, false);
  assert.equal(interrupted.calls.filter(call => call === 'displayPlan:cleanup').length, 1);
});

test('runner has no local-runtime control path', async () => {
  const source = await readFile(new URL('./verify-bilibili-display-plan.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes('local-control'), false);
});

test('seek may advance generation while the same document/resource session remains bound', () => {
  const baseline = pageSessionHash(pageSession);
  assert.doesNotThrow(() => assertStablePageSession(receipt('status', {
    session: { ...pageSession, generation: 9 },
  }), expected.buildId, baseline));
  assert.throws(() => assertStablePageSession(receipt('status', {
    session: { ...pageSession, sessionId: 'different-document', generation: 9 },
  }), expected.buildId, baseline), /Page session changed/);
});
