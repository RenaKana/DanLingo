import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RENDER_PREVIEW_DURATION_MS, RENDER_PREVIEW_SAMPLE_INTERVAL_MS, settingsHash,
  renderPreviewPageSessionHash, assertRenderPreviewBackground, assertRenderPreviewPage,
  projectRenderPreviewReceipt, measureRenderPreviewWindow, pausedPositionSnapshot,
  assertPausedPositionsStable, prepareRenderPreview, runRenderPreview,
  finishRenderPreview, resumeRenderPreview, cleanupRenderPreview,
} from './verify-bilibili-render-preview.mjs';

const expected = { buildId: '0.4.19-test', version: '0.4.19', sourceHash: 'source-fixture' };
const persistentGuard = { key: 'bilibiliUserFilters.zeroTransport.v1', present: true,
  enabled: true, declaredEnabled: false, kind: 'legacy-protection', ownerTabId: null };
const cacheState = { available: true, databaseExists: true, entries: 8, metadataHash: 'a'.repeat(64) };
const pageSession = { platform: 'bilibili', scenario: 'video', resourceId: 'video-session',
  urlResourceId: 'BV-fixture', sessionId: 'document-session', generation: 1 };
const reportRender = (epoch = 2) => ({ contract: 'render-preview-v1', resourceId: 'video-session', epoch,
  mode: 'original', visible: true, closed: false,
  limits: { maxRecords: 1000, maxSamples: 5000, maxMeasurements: 5000, maxLayouts: 64 },
  truncated: { records: false, samples: false }, layouts: [], records: [], samples: [],
  counts: { selected: 0, entered: 0, unknown: 0, visibleDistinct: 0,
    translationLayoutFallback: 0, translationReadyButRejected: 0, lateResults: 0 },
  lateness: { count: 0, minMs: null, medianMs: null, p95Ms: null, maxMs: null },
  ui: { enabled: false, rafActive: false, intersectionActive: false, resizeActive: false,
    activeNodes: 0, measurementNodes: 0, visibilityListenerCount: 0, detailsListenerCount: 0,
    fontListenerCount: 0, motionListenerCount: 0, textInReport: false,
    domSampleCount: 0, domSampleTruncated: false, domSamples: [], activeDomPositions: [] } });

function fixtureHarness({ settings = { enabled: false, backend: 'online', targetLanguage: 'zh-Hans' },
  initialTime = 1_000, activeDomPositions = [], delayedStartStatuses = 0 } = {}) {
  const calls = [], phases = [], files = new Map(), savedSettingsHash = settingsHash(settings);
  const state = { time: initialTime, mediaTimeMs: 20_000, paused: false, seeking: false,
    epoch: 2, seekCount: 0, guard: false, targetClosed: false,
    playbackStarted: false, pendingStartStatuses: 0 };
  const advance = ms => {
    state.time += ms;
    if (!state.paused && !state.seeking) state.mediaTimeMs += ms;
  };
  const bg = action => {
    const active = action !== 'cleanup';
    const protections = { temporaryGuard: { enabled: active, kind: active ? 'render-preview' : null,
      ownerTabId: active ? 7 : null }, persistentGuard, effectiveZeroTransport: active || persistentGuard.enabled };
    return { ok: true, version: expected.version, buildId: expected.buildId, idle: true,
      zeroModelGuard: active, blockedTransports: 0, actualModelCalls: 0, protections,
      ...(action === 'prepare' || action === 'cleanup' ? { cacheState } : {}) };
  };
  const clock = () => ({ resourceId: 'video-session', epoch: state.epoch,
    mediaTimeMs: state.mediaTimeMs, paused: state.paused, seeking: state.seeking, contentActive: true });
  const makePage = (action, { backgroundAction = 'status', simulation = true, closed = false } = {}) => ({
    ok: true, version: expected.version, buildId: expected.buildId,
    session: closed ? { targetClosed: true } : { ...pageSession, generation: state.epoch },
    background: bg(backgroundAction), guardReleased: action === 'cleanup',
    ...(closed ? { closedTargetEvidence: { tabId: 7, exists: false } } : {}),
    report: { coverage: { mainBuildId: expected.buildId },
      simulation: simulation ? { evidence: 'display-plan-memory-provider-only', stopped: action === 'cleanup',
        stopReason: '', resourceId: 'video-session', epoch: state.epoch, inputFrameCount: 0,
        limits: { inputFrames: 12000, inputBytes: 16000000, sourcePool: 20000, sideRecords: 20000 },
        inputBytes: 0, inputTruncated: false, B: { totals: { selected: 0 }, subscriptions: 0,
          activeSubscriptions: 0, submittedSubscriptions: 0, simulatedProviderCalls: 0,
          simulatedProviderInputs: 0, previewExcludedSubscriptions: 0,
          previewExcludedAfterSubmission: 0, orphanInputs: 0, lateResults: 0,
          truncated: false, contextValid: true, events: [], outcomes: [] } } : null,
      render: { ...reportRender(state.epoch), ui: { ...reportRender(state.epoch).ui,
        activeDomPositions: action === 'cleanup' ? [] : activeDomPositions } },
      clock: clock(), playback: { started: state.playbackStarted, restored: action === 'cleanup',
        seekCount: state.seekCount }, restored: action === 'cleanup', actualModelCalls: 0,
      modelLoads: 0, nativeSettingsWrites: 0, adapterPrepared: 0 },
  });
  const control = async (command, payload = {}) => {
    calls.push(`${command}:${payload.type ?? payload.action ?? ''}`);
    if (command === 'rpc' && payload.type === 'settings') return { settings };
    if (command === 'rpc' && payload.type === 'build-identity') return { ok: true,
      version: expected.version, buildId: expected.buildId, idle: true, actualModelCalls: 0,
      protections: { temporaryGuard: { enabled: state.guard, kind: state.guard ? 'render-preview' : null,
        ownerTabId: state.guard ? 7 : null }, persistentGuard,
        effectiveZeroTransport: state.guard || persistentGuard.enabled } };
    if (command === 'reload') return { willReload: true };
    if (command === 'renderPreview') {
      if (payload.action === 'prepare') {
        state.guard = true;
        const page = makePage('prepare');
        page.background = bg('status');
        page.preparedBackground = { ...bg('prepare'), ownerTabId: 7 };
        page.protectionBaseline = persistentGuard;
        return page;
      }
      if (payload.action === 'run') {
        state.guard = true; state.paused = false;
        state.pendingStartStatuses = delayedStartStatuses;
        state.playbackStarted = delayedStartStatuses === 0;
        return makePage('run', { simulation: true });
      }
      if (payload.action === 'status') {
        if (state.pendingStartStatuses > 0 && --state.pendingStartStatuses === 0)
          state.playbackStarted = true;
        return makePage('status', { simulation: true });
      }
      if (payload.action === 'pause') { state.paused = true; return makePage('pause'); }
      if (payload.action === 'play') { state.paused = false; state.playbackStarted = true; return makePage('play'); }
      if (payload.action === 'seek') { state.epoch++; state.seekCount++; state.mediaTimeMs += 12_000; state.paused = false;
        return makePage('seek'); }
      if (payload.action === 'export') return makePage('export');
      if (payload.action === 'cleanup') {
        state.guard = false; state.playbackStarted = false;
        return makePage('cleanup', { backgroundAction: 'cleanup' });
      }
    }
    if (command === 'close-render-preview-owned') { state.targetClosed = true; return { closed: true, tabId: 7 }; }
    throw new Error(`Unexpected command: ${command}`);
  };
  const session = { runIssued: false };
  const checkpoint = async (phase, extra = {}) => {
    Object.assign(session, extra, { phase }); phases.push(phase);
  };
  const save = async (name, result) => {
    const path = `${files.size + 1}-${name}.json`;
    files.set(path, { result }); return path;
  };
  const read = async path => files.get(path);
  return { state, calls, phases, files, session, control, checkpoint, save, read,
    now: () => state.time, advance, sleep: async ms => advance(ms), savedSettingsHash,
    refreshConnection: async () => calls.push('reconnect') };
}

test('prepare records disabled settings, build, temporary and persistent guard baselines, and cache summary', async () => {
  const h = fixtureHarness();
  const prepared = await prepareRenderPreview({ control: h.control, expected,
    checkpoint: h.checkpoint, refreshConnection: h.refreshConnection, sleep: async () => {} });
  assert.equal(prepared.savedSettingsHash, h.savedSettingsHash);
  assert.equal(prepared.pageSessionHash, renderPreviewPageSessionHash(pageSession));
  assert.deepEqual(prepared.persistentGuardBaseline, persistentGuard);
  assert.deepEqual(prepared.cacheStateBaseline, cacheState);
  assert.equal(h.session.phase, 'prepared');
  assert.deepEqual(h.calls, ['rpc:settings', 'rpc:build-identity', 'rpc:settings', 'renderPreview:prepare']);
  const enabled = fixtureHarness({ settings: { enabled: true } });
  await assert.rejects(prepareRenderPreview({ control: enabled.control, expected,
    checkpoint: enabled.checkpoint, refreshConnection: enabled.refreshConnection }), /must be disabled/);
  assert.equal(enabled.calls.some(call => call === 'renderPreview:prepare'), false);
});

test('background receipt accepts both identity nesting forms and rejects underlying guard values', () => {
  const receipt = { ok: true, version: expected.version, buildId: expected.buildId, idle: true,
    zeroModelGuard: true, actualModelCalls: 0, blockedTransports: 0,
    temporaryGuard: { enabled: true, kind: 'render-preview', ownerTabId: 7 }, persistentGuard,
    effectiveZeroTransport: true };
  assert.equal(assertRenderPreviewBackground(receipt, expected.buildId, expected.version,
    { action: 'status', tabId: 7, persistentGuard }).protections.temporaryGuard.enabled, true);
  assert.throws(() => assertRenderPreviewBackground({ ...receipt, persistentGuard: { ...persistentGuard, value: 'secret' } },
    expected.buildId, expected.version, { action: 'status', persistentGuard }), /invalid or contains its underlying value/);
});

test('status projections preserve render samples and numeric B outcomes while excluding input bodies', () => {
  const report = { coverage: { mainBuildId: expected.buildId },
    simulation: { inputFrames: [{ originalText: 'private' }], A: {}, B: { totals: { selected: 1 } } },
    render: reportRender(), clock: { resourceId: 'video-session', epoch: 2, mediaTimeMs: 10_000,
      paused: false, seeking: false, contentActive: true }, playback: { seekCount: 0 },
    actualModelCalls: 0, modelLoads: 0, nativeSettingsWrites: 0, adapterPrepared: 0 };
  const receipt = { ok: true, version: expected.version, buildId: expected.buildId,
    session: pageSession, report };
  const bodyFree = { ...receipt, report: { ...report, simulation: { B: {
    totals: { selected: 1, note: 'private' }, subscriptions: 1, activeSubscriptions: 1,
    submittedSubscriptions: 1, simulatedProviderCalls: 1, simulatedProviderInputs: 1,
    previewExcludedSubscriptions: 0, previewExcludedAfterSubmission: 0, orphanInputs: 0,
    lateResults: 0, events: [{ id: 'opaque-1', epoch: 2, state: 'entered', debug: 'private' }],
    outcomes: [{ key: 'opaque-1:2', id: 'opaque-1', epoch: 2, result: 'accepted', debug: 'private' }],
  } } } };
  assert.equal(assertRenderPreviewPage(bodyFree, expected.buildId, expected.version,
    { action: 'status', expectedSessionHash: renderPreviewPageSessionHash(pageSession) }), bodyFree);
  assert.throws(() => assertRenderPreviewPage(receipt, expected.buildId, expected.version,
    { action: 'status' }), /A branch/);
  const leakingStatus = { ...bodyFree, report: { ...bodyFree.report,
    render: { ...bodyFree.report.render, ui: { ...bodyFree.report.render.ui,
    activeDomPositions: [{ originalText: 'private' }] } } } };
  assert.throws(() => assertRenderPreviewPage(leakingStatus, expected.buildId, expected.version,
    { action: 'status' }), /contains input text or author data/);
  const leakingOutcome = structuredClone(bodyFree);
  leakingOutcome.report.simulation.B.outcomes[0].originalText = 'private';
  assert.throws(() => assertRenderPreviewPage(leakingOutcome, expected.buildId, expected.version,
    { action: 'status' }), /contains input text or author data/);
  assert.throws(() => assertRenderPreviewPage({ ...bodyFree, report: { ...bodyFree.report, adapterPrepared: 1 } },
    expected.buildId, expected.version, { action: 'status' }), /Real adapter received prepared translations/);
  const projected = projectRenderPreviewReceipt(bodyFree, 'status', 1000);
  assert.equal(JSON.stringify(projected).includes('private'), false);
  assert.equal(projected.report.render.contract, 'render-preview-v1');
  assert.equal(projected.report.adapterPrepared, 0);
  assert.deepEqual(projected.report.simulation.B.totals, { selected: 1 });
  assert.deepEqual(Object.fromEntries(['subscriptions', 'activeSubscriptions', 'submittedSubscriptions',
    'simulatedProviderCalls', 'simulatedProviderInputs', 'previewExcludedSubscriptions',
    'previewExcludedAfterSubmission', 'orphanInputs', 'lateResults'].map(key =>
    [key, projected.report.simulation.B[key]])), {
    subscriptions: 1, activeSubscriptions: 1, submittedSubscriptions: 1,
    simulatedProviderCalls: 1, simulatedProviderInputs: 1,
    previewExcludedSubscriptions: 0, previewExcludedAfterSubmission: 0,
    orphanInputs: 0, lateResults: 0 });
  assert.deepEqual(projected.report.simulation.B.events, [{ id: 'opaque-1', epoch: 2, state: 'entered' }]);
  assert.deepEqual(projected.report.simulation.B.outcomes,
    [{ key: 'opaque-1:2', id: 'opaque-1', epoch: 2, result: 'accepted' }]);
});

test('35-second run samples report.clock and render status without replaying run or exporting early', async () => {
  const h = fixtureHarness();
  h.session.expectedBuildId = expected.buildId;
  const prepared = await prepareRenderPreview({ control: h.control, expected,
    checkpoint: h.checkpoint, refreshConnection: h.refreshConnection, sleep: async () => {} });
  Object.assign(h.session, { expectedVersion: expected.version, expectedBuildId: expected.buildId,
    sourceHash: expected.sourceHash, pageSessionHash: prepared.pageSessionHash,
    persistentGuardBaseline: prepared.persistentGuardBaseline,
    cacheStateBaseline: prepared.cacheStateBaseline, savedSettingsHash: prepared.savedSettingsHash });
  const result = await runRenderPreview({ control: h.control, expectedBuildId: expected.buildId,
    expectedVersion: expected.version, expectedSessionHash: prepared.pageSessionHash,
    persistentGuardBaseline: persistentGuard, session: h.session, checkpoint: h.checkpoint,
    save: h.save, now: h.now, sleep: h.sleep });
  assert.equal(result.playbackWindow.wallDurationMs, RENDER_PREVIEW_DURATION_MS);
  assert.equal(result.playbackWindow.observedRate, 1);
  assert.equal(h.calls.filter(call => call === 'renderPreview:run').length, 1);
  assert.equal(h.calls.filter(call => call === 'renderPreview:status').length, 13);
  assert.equal(h.calls.some(call => call === 'renderPreview:export'), false);
  assert.equal(h.session.sampleWindowComplete, true);
  assert.ok([...h.files.values()].some(file => file.result.report?.render?.contract === 'render-preview-v1'));
  assert.equal(RENDER_PREVIEW_SAMPLE_INTERVAL_MS, 3000);
});

test('one run waits for delayed playback confirmation through status before sampling', async () => {
  const h = fixtureHarness({ delayedStartStatuses: 2 });
  const prepared = await prepareRenderPreview({ control: h.control, expected,
    checkpoint: h.checkpoint, refreshConnection: h.refreshConnection, sleep: async () => {} });
  Object.assign(h.session, { expectedVersion: expected.version, expectedBuildId: expected.buildId,
    sourceHash: expected.sourceHash, pageSessionHash: prepared.pageSessionHash,
    persistentGuardBaseline: persistentGuard, cacheStateBaseline: cacheState,
    savedSettingsHash: prepared.savedSettingsHash });
  const result = await runRenderPreview({ control: h.control, expectedBuildId: expected.buildId,
    expectedVersion: expected.version, expectedSessionHash: prepared.pageSessionHash,
    persistentGuardBaseline: persistentGuard, session: h.session, checkpoint: h.checkpoint,
    save: h.save, now: h.now, sleep: h.sleep });
  assert.equal(h.calls.filter(call => call === 'renderPreview:run').length, 1);
  assert.equal(h.calls.filter(call => call === 'renderPreview:status').length, 15);
  assert.equal(result.playbackWindow.wallDurationMs, RENDER_PREVIEW_DURATION_MS);
  assert.equal(h.session.runReceiptObservedAtMs, 1200, 'sample window begins after confirmation');
  assert.equal(h.session.sampleWindowComplete, true);
  const savedStart = [...h.files.values()].find(file => file.result.action === 'run')?.result;
  assert.equal(savedStart.report.playback.started, true);
  assert.equal(savedStart.report.adapterPrepared, 0);
});

test('clock-window analysis rejects a resource or epoch change, pause, seek, and non-1x average rate', () => {
  const points = Array.from({ length: 13 }, (_, index) => ({ observedAtMs: index * 3000,
    resourceId: 'video-session', epoch: 2, mediaTimeMs: index * 3000, paused: false,
    seeking: false, contentActive: true, seekCount: 0 }));
  points[12].observedAtMs = RENDER_PREVIEW_DURATION_MS;
  points[12].mediaTimeMs = RENDER_PREVIEW_DURATION_MS;
  assert.equal(measureRenderPreviewWindow(points).expectedRate, 1);
  assert.throws(() => measureRenderPreviewWindow(points.map((row, index) => ({ ...row, epoch: index === 12 ? 3 : 2 })),), /epoch/);
  assert.throws(() => measureRenderPreviewWindow(points.map((row, index) => ({ ...row, paused: index === 6 })),), /paused/);
  assert.throws(() => measureRenderPreviewWindow(points.map((row, index) => ({ ...row,
    mediaTimeMs: index === 12 ? 41_000 : row.mediaTimeMs })),), /roughly 35 seconds|rate/);
});

test('paused snapshots compare current DOM keys and positions, and detect movement', () => {
  const activeDomPositions = [{ key: 'render-key', mediaTimeMs: 10_000,
    xPx: 20, yPx: 30, widthPx: 120, heightPx: 24 }];
  const h = fixtureHarness({ activeDomPositions });
  const pausedReceipt = { session: pageSession, report: { clock: { resourceId: 'video-session', epoch: 2,
    mediaTimeMs: 10_000, paused: true, seeking: false }, render: { ui: { activeDomPositions } } } };
  const first = pausedPositionSnapshot(pausedReceipt, 10);
  const second = pausedPositionSnapshot(pausedReceipt, 20);
  assert.equal(assertPausedPositionsStable(first, second).keyCount, 1);
  const moved = { ...second, keys: [{ ...second.keys[0], xPx: 25 }] };
  assert.throws(() => assertPausedPositionsStable(first, moved), /position changed/);
  const noPositions = { ...first, keys: [] };
  assert.equal(assertPausedPositionsStable(noPositions, { ...noPositions, observedAtMs: 30 }).positionsStable, null);
  assert.equal(h.state.paused, false, 'Position helper does not touch playback');
});

test('pause, play and seek happen once, then a B-only render export is analyzed', async () => {
  const h = fixtureHarness();
  const prepared = await prepareRenderPreview({ control: h.control, expected,
    checkpoint: h.checkpoint, refreshConnection: h.refreshConnection, sleep: async () => {} });
  Object.assign(h.session, { expectedBuildId: expected.buildId, expectedVersion: expected.version,
    sourceHash: expected.sourceHash, pageSessionHash: prepared.pageSessionHash,
    persistentGuardBaseline: prepared.persistentGuardBaseline, cacheStateBaseline: prepared.cacheStateBaseline,
    savedSettingsHash: prepared.savedSettingsHash, runIssued: true, sampleWindowComplete: true,
    playbackWindow: { wallDurationMs: 35_000 } });
  const finished = await finishRenderPreview({ control: h.control, expectedBuildId: expected.buildId,
    expectedVersion: expected.version, expectedSessionHash: prepared.pageSessionHash,
    persistentGuardBaseline: persistentGuard, session: h.session, checkpoint: h.checkpoint,
    save: h.save, read: h.read, now: h.now, sleep: h.sleep });
  assert.equal(finished.analysis.ok, true);
  assert.equal(h.calls.filter(call => call === 'renderPreview:pause').length, 1);
  assert.equal(h.calls.filter(call => call === 'renderPreview:play').length, 1);
  assert.equal(h.calls.filter(call => call === 'renderPreview:seek').length, 1);
  assert.equal(h.calls.filter(call => call === 'renderPreview:export').length, 1);
  assert.equal(h.session.seekConfirmed, true);
  assert.equal(h.session.finalAnalysisComplete, true);
  const beforeResume = [...h.calls];
  const resumed = await resumeRenderPreview({ control: h.control, expectedBuildId: expected.buildId,
    expectedVersion: expected.version, expectedSessionHash: prepared.pageSessionHash,
    persistentGuardBaseline: persistentGuard, cacheStateBaseline: cacheState,
    session: h.session, checkpoint: h.checkpoint, save: h.save, read: h.read,
    now: h.now, sleep: h.sleep });
  assert.equal(resumed.complete, true);
  assert.equal(h.calls.filter(call => call === 'renderPreview:run').length, 0);
  assert.equal(h.calls.filter(call => call === 'renderPreview:seek').length, 1);
  assert.deepEqual(h.calls.slice(beforeResume.length), ['renderPreview:status']);
});

test('resume recovers uncertain pause and seek by status only, never replaying either action', async () => {
  const h = fixtureHarness();
  const prepared = await prepareRenderPreview({ control: h.control, expected,
    checkpoint: h.checkpoint, refreshConnection: h.refreshConnection, sleep: async () => {} });
  Object.assign(h.session, { expectedBuildId: expected.buildId, expectedVersion: expected.version,
    sourceHash: expected.sourceHash, pageSessionHash: prepared.pageSessionHash,
    persistentGuardBaseline: persistentGuard, cacheStateBaseline: cacheState,
    savedSettingsHash: prepared.savedSettingsHash, runIssued: true, sampleWindowComplete: true,
    pauseIssued: true, pauseConfirmed: false });
  h.state.paused = true;
  await finishRenderPreview({ control: h.control, expectedBuildId: expected.buildId,
    expectedVersion: expected.version, expectedSessionHash: prepared.pageSessionHash,
    persistentGuardBaseline: persistentGuard, session: h.session, checkpoint: h.checkpoint,
    save: h.save, read: h.read, now: h.now, sleep: h.sleep });
  assert.equal(h.calls.filter(call => call === 'renderPreview:pause').length, 0);
  assert.equal(h.calls.filter(call => call === 'renderPreview:seek').length, 1);
});

test('cleanup restores first, compares temporary/persistent guard and cache summary, closes owned target, and checks settings', async () => {
  const h = fixtureHarness();
  const prepared = await prepareRenderPreview({ control: h.control, expected,
    checkpoint: h.checkpoint, refreshConnection: h.refreshConnection, sleep: async () => {} });
  Object.assign(h.session, { expectedBuildId: expected.buildId, expectedVersion: expected.version,
    pageSessionHash: prepared.pageSessionHash, persistentGuardBaseline: persistentGuard,
    cacheStateBaseline: cacheState, savedSettingsHash: prepared.savedSettingsHash, ownedTargetTabId: 7 });
  const result = await cleanupRenderPreview({ control: h.control, expectedBuildId: expected.buildId,
    expectedVersion: expected.version, expectedSessionHash: prepared.pageSessionHash,
    persistentGuardBaseline: persistentGuard, cacheStateBaseline: cacheState,
    savedSettingsHash: prepared.savedSettingsHash, session: h.session,
    checkpoint: h.checkpoint, save: h.save, read: h.read });
  assert.equal(result.savedSettingsUnchanged, true);
  assert.equal(result.cacheUnchanged, true);
  assert.equal(result.persistentGuardUnchanged, true);
  assert.deepEqual(h.calls.slice(-3), ['renderPreview:cleanup', 'close-render-preview-owned:', 'rpc:settings']);
  assert.equal(h.session.phase, 'cleaned');
});
