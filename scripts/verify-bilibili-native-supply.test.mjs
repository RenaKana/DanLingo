import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertNativeBudget, assertNativePage, nativeSupplySummary, parseNativeSupplyArgs,
  assertRepairContinuation, prepareNativeSupply, replayNativeSupply, runNativeReference,
  runFullNativeReference, runOfficialNativeReference, runNativeSupply } from './verify-bilibili-native-supply.mjs';

const budget = () => ({ total: { limits: { requests: 100, items: 100, utf16Chars: 2000 },
  occupied: { requests: 1, items: 2, utf16Chars: 12 },
  actualSent: { requests: 1, items: 2, utf16Chars: 12 } } });
const session = () => ({ taskId: 'task-1', runId: 'run-1', instanceId: 'instance-1',
  pageSessionHash: null, ownedTargetTabId: 17, epoch: 1, runIssued: false,
  fromMs: 0, toMs: 45_000 });
const page = (s, state = 'armed', mediaTimeMs = 0, hostState = 'prepared') => ({
  ok: true, buildId: 'build-1', state, epoch: s.epoch,
  session: { platform: 'bilibili', scenario: 'video', resourceId: 'av117318021548752:cid42173138507',
    sessionId: 'document-1' },
  clock: { mediaTimeMs, paused: state === 'paused', seeking: false },
  events: [], host: { ok: true, buildId: 'build-1', onlineCalls: 0, budget: budget(), activeRequests: 0,
    grant: { taskId: s.taskId, runId: s.runId, tabId: 17, instanceId: s.instanceId,
      epoch: s.epoch, state: hostState }, nativeSupply: { cacheOnly: s.cacheOnly === true } },
});

test('CLI restricts the 7B model and bounded repair range before opening transport', () => {
  assert.deepEqual(parseNativeSupplyArgs(['prepare', '--model-id', '353f28dc-b75a-4064-af47-493661733f09']),
    { command: 'prepare', modelId: '353f28dc-b75a-4064-af47-493661733f09',
      phase: 'main', fromMs: 0, toMs: 45_000 });
  assert.deepEqual(parseNativeSupplyArgs(['recover-prepare']), { command: 'recover-prepare' });
  assert.deepEqual(parseNativeSupplyArgs(['reference-full']), { command: 'reference-full' });
  assert.deepEqual(parseNativeSupplyArgs(['reference-official']), { command: 'reference-official' });
  assert.deepEqual(parseNativeSupplyArgs(['reference-official-remaining']),
    { command: 'reference-official-remaining' });
  assert.deepEqual(parseNativeSupplyArgs(['prepare', '--model-id', '7b', '--phase', 'repair',
    '--reason', 'verified defect', '--from-ms', '10000', '--to-ms', '25000']).toMs, 25_000);
  for (const args of [
    ['prepare'], ['prepare', '--model-id', '7b', '--phase', 'repair', '--reason', 'x',
      '--from-ms', '0', '--to-ms', '16000'],
    ['prepare', '--model-id', '7b', '--url', 'https://example.com'],
    ['run', '--repeat'], ['reference-full', '--model-id', 'registered'],
    ['reference-official', '--model-id', 'registered'],
    ['reference-official-remaining', '--model-id', 'registered'],
  ]) assert.throws(() => parseNativeSupplyArgs(args));
});

test('recovering the failed 7B load reuses the task, run and settings without starting playback', async () => {
  const settings = { enabled: false, backend: 'local', localModelId: 'other-model' };
  const s = { ...session(), phaseName: 'main', phase: 'attention-required', resumePhase: 'reloading',
    modelId: 'registered-7b', savedSettingsHash: createHash('sha256')
      .update(JSON.stringify(settings)).digest('hex') };
  const actions = [], checkpoints = [];
  const control = async (command, payload) => {
    actions.push(`${command}:${payload.type ?? payload.action}`);
    if (command === 'rpc' && payload.type === 'settings') return { settings };
    if (command === 'rpc' && payload.type === 'build-identity')
      return { buildId: 'build-1', version: '0.4.23', idle: true };
    if (command === 'nativeSupply' && payload.action === 'recover-prepare') {
      assert.deepEqual([payload.taskId, payload.runId, payload.modelId, payload.phase],
        [s.taskId, s.runId, s.modelId, 'main']);
      const result = page(s);
      result.host.grant = { ...result.host.grant, session: { ...result.session }, modelId: s.modelId,
        modelIdentityKind: 'metadata-only-sha256', fromMs: 0, toMs: 45_000 };
      result.preparedPage = page(s, 'paused');
      result.ownedTargetTabId = 17;
      return result;
    }
    throw Error('unexpected recovery command');
  };
  await prepareNativeSupply({ control, expected: { buildId: 'build-1', version: '0.4.23' },
    session: s, recovering: true,
    checkpoint: async (phase, fields) => { checkpoints.push(phase); Object.assign(s, fields, { phase }); },
    save: async () => {} });
  assert.deepEqual(actions, ['rpc:settings', 'rpc:build-identity', 'rpc:settings',
    'nativeSupply:recover-prepare']);
  assert.deepEqual(checkpoints, ['recovery-issuing', 'prepared']);
  assert.equal(s.runIssued, false);
  assert.equal(s.taskId, 'task-1');
  assert.equal(s.runId, 'run-1');
  assert.equal(s.ownedTargetTabId, 17);
  const wrong = { ...s, phase: 'attention-required', resumePhase: 'reloading', savedSettingsHash: 'changed' };
  await assert.rejects(prepareNativeSupply({ control, expected: { buildId: 'build-1' },
    session: wrong, recovering: true, checkpoint: async () => {}, save: async () => {} }),
  /Saved settings differ/);
  assert.equal(actions.filter(value => value === 'nativeSupply:recover-prepare').length, 1);
});

test('one extra model load requires explicit bounded repair and an unused cleaned failure', () => {
  const argv = ['prepare', '--model-id', '7b', '--phase', 'repair', '--reason', 'User authorized fixed startup retest',
    '--from-ms', '0', '--to-ms', '15000', '--extra-model-load', '1'];
  const args = parseNativeSupplyArgs(argv);
  assert.equal(args.authorizedExtraLoad, true);
  const prior = { taskId: 'task-1', runId: 'old-main', phase: 'cleaned', phaseName: 'main',
    runIssued: true, cleanupConfirmed: true, resumePhase: 'start-issuing', error: 'startup paused',
    modelId: '7b', savedSettingsHash: 'original', repairUsed: false };
  assert.doesNotThrow(() => assertRepairContinuation(prior, args));
  for (const patch of [{ cleanupConfirmed: false }, { runIssued: false }, { repairUsed: true },
    { phaseName: 'repair' }, { phase: 'attention-required' }, { modelId: 'other' }, { replayIssued: true },
    { resumePhase: 'preparing' }, { savedSettingsHash: undefined }])
    assert.throws(() => assertRepairContinuation({ ...prior, ...patch }, args));
  assert.throws(() => assertRepairContinuation(prior, { ...args, authorizedExtraLoad: undefined }));
  assert.throws(() => parseNativeSupplyArgs([...argv.slice(0, -1), '2']));
  assert.throws(() => parseNativeSupplyArgs(['prepare', '--model-id', '7b', '--extra-model-load', '1']));
});

test('authorized repair carries the old budget identity and never implicitly starts playback', async () => {
  const settings = { enabled: false, backend: 'local', localModelId: 'ordinary-model' };
  const s = { ...session(), phaseName: 'repair', modelId: 'registered-7b', authorizedExtraLoad: true,
    repairReason: 'User authorized fixed startup retest', previousRunId: 'old-main', toMs: 15_000,
    savedSettingsHash: createHash('sha256').update(JSON.stringify(settings)).digest('hex') };
  const actions = [];
  const control = async (command, payload) => {
    actions.push(`${command}:${payload.type ?? payload.action}`);
    if (payload.type === 'settings') return { settings };
    if (payload.type === 'build-identity') return { buildId: 'build-1', version: '0.4.23', idle: true };
    assert.equal(command, 'nativeSupply'); assert.equal(payload.action, 'prepare');
    assert.equal(payload.authorizedExtraLoad, true); assert.equal(payload.taskId, s.taskId);
    const result = page(s);
    result.host.grant = { ...result.host.grant, session: result.session, modelId: s.modelId,
      modelIdentityKind: 'metadata-only-sha256', modelLoads: 3, fromMs: 0, toMs: 15_000 };
    result.host.budget.phases = { main: { runId: 'old-main' } };
    result.preparedPage = page(s, 'paused'); result.ownedTargetTabId = 17;
    return result;
  };
  await prepareNativeSupply({ control, expected: { buildId: 'build-1', version: '0.4.23' }, session: s,
    checkpoint: async (phase, patch) => Object.assign(s, patch, { phase }), save: async () => {} });
  assert.equal(s.phase, 'prepared'); assert.equal(s.runIssued, false);
  assert.deepEqual(actions, ['rpc:settings', 'rpc:build-identity', 'rpc:settings', 'nativeSupply:prepare']);
});

test('budget caps include occupied uncertain sends; cache replay cannot spend another input', () => {
  const host = { ok: true, onlineCalls: 0, budget: budget() };
  const baseline = assertNativeBudget(host);
  assertNativeBudget(host, baseline);
  host.budget.total.occupied.items = 101;
  assert.throws(() => assertNativeBudget(host));
  host.budget.total.occupied.items = 3;
  assert.throws(() => assertNativeBudget(host, baseline));
  host.budget.total.occupied.items = 2;
  host.budget.total.actualSent.items = 3;
  assert.throws(() => assertNativeBudget(host, baseline));
  host.budget.total.actualSent.items = 2;
  host.onlineCalls = 1;
  assert.throws(() => assertNativeBudget(host));
});

test('page proof binds the fixed CID and records actual native categories separately', () => {
  const s = session(), receipt = page(s, 'paused', 0);
  assertNativePage(receipt, { buildId: 'build-1' }, { epoch: 1, prepareAt: 0 });
  receipt.session.resourceId = 'wrong';
  assert.throws(() => assertNativePage(receipt, { buildId: 'build-1' }));
  receipt.session.resourceId = 'av117318021548752:cid42173138507';
  receipt.events = ['nativeAdmissionOpportunity', 'nativeAdmissionOpportunity', 'adopted', 'suppressed',
    'nativeFirstShow', 'domSample'].map(type => ({ type }));
  const summary = nativeSupplySummary(receipt, receipt.host);
  assert.deepEqual([summary.admissions, summary.direct, summary.suppressed, summary.firstShow,
    summary.domSamples], [2, 1, 1, 1, 1]);
  assert.equal(summary.replacement, 'unavailable');
});

test('zero-call reference plays to 52s, exports native lifecycle, and releases only its guard', async () => {
  const s = session(), actions = [], saved = [];
  const source = (mediaTimeMs, paused) => ({ ...page(s, 'disabled', mediaTimeMs),
    clock: { mediaTimeMs, paused, seeking: false },
    background: { actualModelCalls: 0, protections: { effectiveZeroTransport: true } },
    shadow: { known: true, observed: { instrumentationErrors: 0 },
      ledger: { classification: { eventTypes: { shadowSelected: 4 } },
        events: [{ type: 'nativeInitRender', stimeMs: 4000 },
          { type: 'nativeInitRender', stimeMs: 7000 }, { type: 'nativeInitRender', stimeMs: 20000 }] } },
  });
  const control = async (command, payload) => {
    actions.push(`${command}:${payload.type ?? payload.action}`);
    if (command === 'rpc' && payload.type === 'build-identity')
      return { buildId: 'build-1', version: '0.4.23', idle: true };
    if (command === 'rpc' && payload.type === 'settings')
      return { settings: { enabled: false, bilibiliNativeTranslationOnly: false } };
    if (payload.action === 'reference-start') return source(0, false);
    if (payload.action === 'reference-status') return source(52_000, true);
    if (payload.action === 'reference-stop' || payload.action === 'reference-export') return source(52_000, true);
    if (payload.action === 'reference-cleanup') return { guardReleased: true, closed: true };
    throw Error('unexpected action');
  };
  const result = await runNativeReference({ control, expected: { buildId: 'build-1', version: '0.4.23' },
    save: async name => saved.push(name), sleep: async () => {} });
  assert.deepEqual(result.summary.nativeInitRender0to45, 3);
  assert.deepEqual([result.summary.nativeInitRender0to5, result.summary.nativeInitRender5to10,
    result.summary.nativeInitRender10to45], [1, 1, 1]);
  assert.deepEqual(actions.slice(-4), ['nativeSupply:reference-status', 'nativeSupply:reference-stop',
    'nativeSupply:reference-export', 'nativeSupply:reference-cleanup']);
  assert.ok(saved.includes('reference-export') && saved.includes('reference-cleanup'));
});

test('full reference records incremental non-pausing evidence through natural end, including unknown forecasts', async () => {
  const s = session(), actions = [], saved = [], local = { phase: 'ready', generation: 3,
    inferenceCalls: 105, active: 0, queued: 0, model: { id: 'already-ready' } };
  let clock = 0, index = 0;
  const source = (mediaTimeMs, ended, length) => ({ ...page(s, 'disabled', mediaTimeMs),
    clock: { mediaTimeMs, paused: ended, seeking: false },
    reference: { fullVideo: true, durationMs: 8000, ended, truncated: false,
      startedAtEpochMs: 1000, sampleCount: length,
      forecastCount: length, samples: Array.from({ length }, (_, n) => ({
        atEpochMs: 1000 + n * 2000, mediaTimeMs: n * 2000, paused: false, seeking: false,
        visible: true, playbackRate: 1, ended: n === 3 })),
      forecasts: Array.from({ length }, (_, n) => ({ known: false, items: [],
        atEpochMs: 1000 + n * 2000, mediaTimeMs: n * 2000 })) },
    shadow: { known: false, reportedAtEpochMs: 9000, reportedMonotonicMs: 8000,
      observed: { instrumentationErrors: 0 },
      ledger: { truncated: false, events: Array.from({ length }, (_, n) => ({ type: 'nativeInitRender',
        stimeMs: n * 2000, wallTimeMs: n * 2000 })), predictions: [] } },
    events: [], background: { actualModelCalls: 0,
      protections: { effectiveZeroTransport: true } },
  });
  const control = async (command, payload) => {
    actions.push(`${command}:${payload.type ?? payload.action}`);
    if (command === 'rpc' && payload.type === 'build-identity')
      return { buildId: 'build-1', version: '0.4.24', idle: true };
    if (command === 'rpc' && payload.type === 'settings')
      return { settings: { enabled: false, bilibiliNativeTranslationOnly: false } };
    if (command === 'rpc' && payload.type === 'local-control') {
      assert.deepEqual(payload.control, { action: 'state' }); return { ok: true, state: local };
    }
    if (payload.action === 'reference-full-start') return source(0, false, 0);
    if (payload.action === 'reference-snapshot') {
      index++; return source(Math.min(index * 2000, 8000), index === 4, index);
    }
    if (payload.action === 'reference-cleanup') return { guardReleased: true, closed: true };
    throw Error(`unexpected action: ${payload.action}`);
  };
  const { summary } = await runFullNativeReference({ control,
    expected: { buildId: 'build-1', version: '0.4.24' },
    save: async (name, value) => saved.push({ name, value }),
    sleep: async ms => { clock += ms; }, now: () => clock });
  assert.equal(summary.ended, true);
  assert.equal(summary.shadowKnown, false, 'unknown contract is evidence, not a run failure');
  assert.equal(summary.forecastItems, 0);
  assert.equal(summary.forecastUnknown, 4);
  assert.equal(summary.nativeInitRender, 4);
  assert.equal(saved.filter(row => row.name.startsWith('reference-full-snapshot-')).length, 4);
  assert.deepEqual(saved.filter(row => row.name.startsWith('reference-full-snapshot-'))
    .map(row => row.value.samples.length), [1, 1, 1, 1]);
  assert.equal(saved.find(row => row.name === 'reference-full-export').value.reference.samples.length, 4);
  assert.ok(saved.some(row => row.name === 'reference-full-after'));
  assert.equal(actions.filter(row => row === 'nativeSupply:reference-snapshot').length, 4);
  assert.equal(actions.some(row => /reference-stop|reference-export|local-control:load|prepare/.test(row)), false);
  assert.equal(actions.at(-4), 'nativeSupply:reference-cleanup');
});

test('full reference records a persistent playback stall and cleans its owned guard', async () => {
  const s = session(), saved = [], actions = [];
  let clock = 0;
  const source = { ...page(s, 'disabled', 0),
    clock: { mediaTimeMs: 0, paused: true, seeking: false },
    reference: { fullVideo: true, durationMs: 100000, ended: false, truncated: false,
      samples: [], forecasts: [] },
    shadow: { known: false, ledger: { events: [] } }, events: [],
    background: { actualModelCalls: 0, protections: { effectiveZeroTransport: true } } };
  const control = async (command, payload) => {
    actions.push(`${command}:${payload.type ?? payload.action}`);
    if (payload.type === 'build-identity') return { buildId: 'build-1', version: '0.4.24', idle: true };
    if (payload.type === 'settings') return { settings: { enabled: false, bilibiliNativeTranslationOnly: false } };
    if (payload.type === 'local-control') return { ok: true, state: { phase: 'idle', active: 0,
      queued: 0, generation: 3, inferenceCalls: 0 } };
    if (payload.action === 'reference-full-start' || payload.action === 'reference-snapshot') return source;
    if (payload.action === 'reference-cleanup') return { guardReleased: true, closed: true };
    throw Error('unexpected action');
  };
  await assert.rejects(runFullNativeReference({ control,
    expected: { buildId: 'build-1', version: '0.4.24' },
    save: async name => saved.push(name), sleep: async ms => { clock += ms; }, now: () => clock }),
  /stopped for at least 12 seconds/);
  assert.ok(saved.includes('reference-full-snapshot-0006'));
  assert.ok(saved.includes('reference-full-cleanup'));
  assert.ok(saved.includes('reference-full-after'));
  assert.equal(actions.filter(row => row === 'nativeSupply:reference-full-start').length, 1);
  assert.equal(actions.filter(row => row === 'nativeSupply:reference-cleanup').length, 1);
});

test('four official rounds keep independent tabs, export incremental evidence, and restore zero-call state', async () => {
  const modes = ['native-1', 'native-3', 'native-5', 'dom'];
  const requested = [1, 3, 5, null], actions = [], saved = [], progress = [];
  let round = -1, sample = 0, clock = 0;
  const local = { phase: 'idle', active: 0, queued: 0, generation: 4, inferenceCalls: 0 };
  const report = (stopped = false) => ({ runId: `run-${round}`, mode: modes[round], ready: true,
    error: null, stopped, preTime: { original: 0, originalCadence: 0,
      current: stopped ? 0 : requested[round] ?? 0,
      cadence: stopped ? 0 : requested[round] ?? 0,
      requested: requested[round], restored: stopped },
    capacityExceeded: false, instrumentationErrors: 0, methodHooks: !stopped && modes[round] !== 'dom',
    metadata: {}, settingsEvidence: {},
    nativeContracts: modes[round] === 'dom' ? null : { fetchAndInitDm: 'preTime', shouldFetchAndInitDm: 'preTime' },
    sourcePool: modes[round] === 'dom' ? [] : [{ dmid: '1', text: '原文' }],
    events: modes[round] === 'dom' ? [] : [{ type: 'nativeFetch', atEpochMs: 100, mediaTimeMs: 0,
      dmid: null, text: null, batch: 1 }],
    dom: Array.from({ length: sample }, (_, n) => ({ elementId: `element-${n}`, dmid: null,
      text: '原文', firstSeenAtEpochMs: 1000 + n * 2000, firstSeenMediaMs: n * 2000 })) });
  const reply = (stopped = false) => ({ ...page({ ...session(), epoch: 1 }, 'running', sample * 2000),
    ownedTargetTabId: 20 + round,
    clock: { mediaTimeMs: sample * 2000, paused: stopped, seeking: false },
    official: { mode: modes[round], runId: `run-${round}`, fullVideo: true,
      durationMs: 4000, startedAtEpochMs: 1000, ended: sample >= 2,
      truncated: false, samples: Array.from({ length: sample }, (_, n) => ({
        atEpochMs: 1000 + n * 2000, mediaTimeMs: n * 2000, paused: false, seeking: false,
        playbackRate: 1, visible: true, ended: false })) },
    officialReport: report(stopped),
    background: { actualModelCalls: 0, protections: { effectiveZeroTransport: true } } });
  const control = async (command, payload) => {
    actions.push(`${command}:${payload.type ?? payload.action}`);
    if (command === 'rpc' && payload.type === 'build-identity')
      return { buildId: 'build-1', version: '0.4.24', idle: true };
    if (command === 'rpc' && payload.type === 'settings')
      return { settings: { enabled: false, bilibiliNativeTranslationOnly: false } };
    if (command === 'rpc' && payload.type === 'local-control') return { ok: true, state: local };
    if (payload.action.endsWith('-start')) {
      round = modes.findIndex(mode => payload.action ===
        `reference-official-${mode === 'dom' ? 'dom' : mode.slice(7)}-start`);
      assert.ok(round >= 0); sample = 0; return reply();
    }
    if (payload.action === 'reference-snapshot') { sample++; return reply(); }
    if (payload.action === 'reference-stop') return reply(true);
    if (payload.action === 'reference-cleanup')
      return { guardReleased: true, closed: true, ownedTargetTabId: 20 + round };
    throw Error(`Unexpected ${payload.action}`);
  };
  const result = await runOfficialNativeReference({ control,
    expected: { buildId: 'build-1', version: '0.4.24' },
    save: async (name, value) => saved.push({ name, value }),
    sleep: async ms => { clock += ms; }, now: () => clock,
    log: row => progress.push(JSON.parse(row)) });
  assert.deepEqual(result.rounds.map(row => row.mode), modes);
  assert.deepEqual(result.rounds.map(row => row.tabId), [20, 21, 22, 23]);
  assert.deepEqual(actions.filter(row => row.endsWith('-start')),
    modes.map(mode => `nativeSupply:reference-official-${mode === 'dom' ? 'dom' : mode.slice(7)}-start`));
  assert.equal(actions.filter(row => row === 'nativeSupply:reference-snapshot').length, 8);
  assert.equal(actions.filter(row => row === 'nativeSupply:reference-cleanup').length, 4);
  assert.equal(saved.filter(row => row.name.includes('-snapshot-')).length, 8);
  assert.equal(saved.filter(row => row.name.endsWith('-export')).length, 4);
  assert.equal(saved.find(row => row.name === 'reference-official-native-1-snapshot-0002').value.dom.length, 1);
  assert.ok(saved.find(row => row.name === 'reference-official-summary'));
  assert.deepEqual(progress, []);
  const actionCount = actions.length, saveCount = saved.length;
  const remaining = await runOfficialNativeReference({ control,
    expected: { buildId: 'build-1', version: '0.4.24' },
    save: async (name, value) => saved.push({ name, value }),
    sleep: async ms => { clock += ms; }, now: () => clock, log: () => {},
    rounds: ['native-3', 'native-5', 'dom'] });
  assert.deepEqual(remaining.rounds.map(row => row.mode), ['native-3', 'native-5', 'dom']);
  assert.deepEqual(actions.slice(actionCount).filter(row => row.endsWith('-start')),
    ['nativeSupply:reference-official-3-start', 'nativeSupply:reference-official-5-start',
      'nativeSupply:reference-official-dom-start']);
  assert.deepEqual(saved.slice(saveCount).find(row => row.name === 'reference-official-summary').value.selectedModes,
    ['native-3', 'native-5', 'dom']);
  const domActions = actions.length;
  const domOnly = await runOfficialNativeReference({ control,
    expected: { buildId: 'build-1', version: '0.4.24' }, save: async () => {},
    sleep: async ms => { clock += ms; }, now: () => clock, log: () => {}, rounds: ['dom'] });
  assert.deepEqual(domOnly.rounds.map(row => row.mode), ['dom']);
  assert.deepEqual(actions.slice(domActions).filter(row => row.endsWith('-start')),
    ['nativeSupply:reference-official-dom-start']);
  assert.deepEqual(parseNativeSupplyArgs(['reference-official-dom']), { command: 'reference-official-dom' });
  await assert.rejects(runOfficialNativeReference({ control, expected: {}, save: async () => {},
    rounds: ['native-5'] }), /fixed 3\/5\/DOM continuation/);
});

test('hidden playback fails on the first post-start sample and preserves its full report before cleanup', async () => {
  const actions = [], saved = [];
  const local = { phase: 'idle', active: 0, queued: 0, generation: 1, inferenceCalls: 0 };
  const pageReply = hidden => ({ ...page(session(), 'running', hidden ? 2000 : 0),
    ownedTargetTabId: 31,
    official: { mode: 'native-3', runId: 'run-3', fullVideo: true, durationMs: 4000,
      startedAtEpochMs: 1000, ended: false, truncated: false,
      samples: hidden ? [{ atEpochMs: 1200, mediaTimeMs: 200, visible: false,
        seeking: false, playbackRate: 1, ended: false }] : [] },
    officialReport: { runId: 'run-3', mode: 'native-3', ready: true, error: null,
      stopped: false, preTime: { original: 1, originalCadence: 1,
        requested: 3, current: 3, cadence: 3 }, capacityExceeded: false,
      instrumentationErrors: 0, methodHooks: true, metadata: {}, settingsEvidence: {},
      nativeContracts: { fetchAndInitDm: 'preTime', shouldFetchAndInitDm: 'preTime' },
      events: [{ type: 'nativeFetch', atEpochMs: 1100, mediaTimeMs: 0 }], dom: [], sourcePool: [] },
    background: { actualModelCalls: 0, protections: { effectiveZeroTransport: true } } });
  const control = async (command, payload) => {
    actions.push(`${command}:${payload.type ?? payload.action}`);
    if (payload.type === 'build-identity') return { buildId: 'build-1', version: '0.4.24', idle: true };
    if (payload.type === 'settings') return { settings: { enabled: false, bilibiliNativeTranslationOnly: false } };
    if (payload.type === 'local-control') return { ok: true, state: local };
    if (payload.action === 'reference-official-3-start') return pageReply(false);
    if (payload.action === 'reference-snapshot') return pageReply(true);
    if (payload.action === 'reference-cleanup') return { guardReleased: true, closed: true,
      ownedTargetTabId: 31, page: { officialReport: { events: [] } } };
    throw Error(`Unexpected ${payload.action}`);
  };
  await assert.rejects(runOfficialNativeReference({ control,
    expected: { buildId: 'build-1', version: '0.4.24' },
    save: async (name, value) => saved.push({ name, value }),
    sleep: async () => {}, rounds: ['native-3', 'native-5', 'dom'] }),
  /playback interrupted.*visible=false/);
  const failure = saved.find(row => row.name === 'reference-official-native-3-failure-evidence').value;
  assert.equal(failure.lastVerifiedSnapshot.officialReport.events.length, 1);
  assert.equal(failure.lastVerifiedSnapshot.official.samples[0].visible, false);
  assert.equal(saved.find(row => row.name === 'reference-official-native-3-cleanup').value.page.officialReport.events.length, 0);
  assert.equal(actions.filter(row => row.endsWith('-start')).length, 1);
  assert.equal(actions.filter(row => row === 'nativeSupply:reference-snapshot').length, 1);
});

test('official cadence mismatch aborts and still cleans the owned tab', async () => {
  const actions = [], saved = [];
  const local = { phase: 'idle', active: 0, queued: 0, generation: 1, inferenceCalls: 0 };
  const control = async (command, payload) => {
    actions.push(`${command}:${payload.type ?? payload.action}`);
    if (payload.type === 'build-identity') return { buildId: 'build-1', version: '0.4.24', idle: true };
    if (payload.type === 'settings') return { settings: { enabled: false, bilibiliNativeTranslationOnly: false } };
    if (payload.type === 'local-control') return { ok: true, state: local };
    if (payload.action === 'reference-cleanup') return { guardReleased: true, closed: true };
    return { ...page(session(), 'running', 0), ownedTargetTabId: 20,
      official: { mode: 'native-1', runId: 'run-1', fullVideo: true, durationMs: 4000,
        startedAtEpochMs: 1000, ended: false, truncated: false, samples: [] },
      officialReport: { runId: 'run-1', mode: 'native-1', ready: true, stopped: false,
        preTime: { original: 0, originalCadence: 0, requested: 1, current: 1, cadence: 3 },
        capacityExceeded: false, instrumentationErrors: 0, methodHooks: true,
        metadata: {}, settingsEvidence: {}, events: [], dom: [], sourcePool: [] },
      background: { actualModelCalls: 0, protections: { effectiveZeroTransport: true } } };
  };
  await assert.rejects(runOfficialNativeReference({ control,
    expected: { buildId: 'build-1', version: '0.4.24' }, save: async name => saved.push(name) }),
  /scheduler cadence/);
  assert.equal(actions.filter(row => row === 'nativeSupply:reference-cleanup').length, 1);
  assert.ok(saved.includes('reference-official-native-1-cleanup'));
  assert.ok(saved.includes('reference-official-native-1-after'));
});

test('cold observation drains at 45s, stops at 52s, and exports without a second start', async () => {
  const s = session(), actions = [], checkpoints = [], saved = [];
  let status = 0;
  const control = async (command, payload) => {
    assert.equal(command, 'nativeSupply'); actions.push(payload.action);
    if (payload.action === 'status') {
      const sample = status++;
      if (sample === 0) return page(s, 'armed', 0, 'prepared');
      return sample === 1 ? page(s, 'running', 45_000, 'running') : page(s, 'paused', 52_000, 'draining');
    }
    if (payload.action === 'run') return page(s, 'running', 0, 'running');
    if (payload.action === 'drain') return page(s, 'draining', 45_000, 'draining');
    if (payload.action === 'stop') return page(s, 'paused', 52_000, 'stopped');
    if (payload.action === 'export') {
      const value = page(s, 'paused', 52_000, 'stopped');
      value.events = [{ type: 'adopted' }, { type: 'suppressed' }]; return value;
    }
    throw Error('unexpected action');
  };
  const result = await runNativeSupply({ control, expected: { buildId: 'build-1' }, session: s,
    checkpoint: async (phase, extra) => { checkpoints.push(phase); Object.assign(s, extra); },
    save: async name => saved.push(name), sleep: async () => {} });
  assert.deepEqual(actions, ['status', 'run', 'status', 'drain', 'status', 'stop', 'export']);
  assert.equal(actions.filter(value => value === 'run').length, 1);
  assert.equal(result.summary.direct, 1);
  assert.equal(s.phase, undefined);
  assert.deepEqual(checkpoints, ['start-issuing', 'cold-complete']);
  assert.ok(saved.includes('cold-export'));
});

test('replay rotates playback epoch and permit while preserving the cold cost', async () => {
  const s = { ...session(), phase: 'cold-complete', runIssued: true, coldBudget: budget().total };
  const calls = [], checkpoints = [];
  const control = async (_command, payload) => {
    calls.push(payload.action);
    if (payload.action === 'status') return page(s, 'paused', 52_000, 'stopped');
    if (payload.action === 'replay') {
      const next = page({ ...s, epoch: 2, instanceId: 'instance-2' }, 'armed', 0, 'prepared');
      next.clock.paused = true;
      next.host.grant.cacheOnly = true;
      return next;
    }
    throw Error('unexpected action');
  };
  await replayNativeSupply({ control, expected: { buildId: 'build-1' }, session: s,
    checkpoint: async (phase, extra) => { checkpoints.push(phase); Object.assign(s, extra); },
    save: async () => {} });
  assert.deepEqual(calls, ['status', 'replay']);
  assert.equal(s.epoch, 2);
  assert.equal(s.cacheOnly, true);
  assert.equal(s.runIssued, false);
  assert.deepEqual(checkpoints, ['replay-issuing', 'replay-prepared']);
});

test('a fatal early pause saves the failed state without waiting or issuing a second start', async () => {
  const s = { ...session(), toMs: 15_000 }, saved = [], actions = [];
  let samples = 0;
  const control = async (_command, payload) => {
    actions.push(payload.action);
    if (payload.action === 'run') return page(s, 'running', 0, 'running');
    if (samples++ === 0) return page(s, 'armed', 0, 'prepared');
    return { ...page(s, 'paused', 100, 'stopped'), reason: 'permit invalidated' };
  };
  await assert.rejects(runNativeSupply({ control, expected: { buildId: 'build-1' }, session: s,
    checkpoint: async (_phase, patch) => Object.assign(s, patch), save: async name => saved.push(name),
    sleep: async () => {} }), /permit invalidated/);
  assert.deepEqual(actions, ['status', 'run', 'status']);
  assert.deepEqual(saved, ['cold-started', 'interrupted']);
});
