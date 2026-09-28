import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeSupplyWatch } from '../../src/diagnostics/native-supply-watch.ts';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../src/core/config.ts';

function fixture() {
  const f = { rpc: [], sent: [], received: [], closed: [], configured: [], controls: [], demands: [] };
  f.context = { ready: true, epoch: 1, configVersion: 2, visible: true,
    session: { platform: 'bilibili', scenario: 'video', resourceId: 'av1:cid2', sessionId: 'doc', generation: 3 },
    settings: { ...DEFAULT_SETTINGS, enabled: false }, clock: { mediaTimeMs: 0, paused: true, seeking: false, playbackRate: 1, contentActive: true },
    video: { seeking: false, pause() { f.context.clock.paused = true; }, async play() { f.context.clock.paused = false; },
      set currentTime(value) { f.context.clock.mediaTimeMs = value * 1000; } } };
  f.watch = new NativeSupplyWatch({ buildId: 'test', context: () => f.context, demands: () => f.demands,
    rpc: async message => { f.rpc.push(message); return f.reply?.(message) ?? { ok: true }; },
    configure: s => f.configured.push(s), control: extra => {
      f.controls.push({ extra, official: f.watch.officialObservationValue() }); f.onControl?.(extra);
    }, send: m => f.sent.push(m),
    original: id => id === 'miss' ? '未预测内容' : undefined,
    close: (...args) => f.closed.push(args) });
  f.grant = { runId: 'r', instanceId: 'i', configIdentity: 'config', buildId: 'test', configVersion: 2,
    epoch: 1, session: { ...f.context.session }, fromMs: 0, toMs: 45000 };
  return f;
}
async function start(f) {
  await f.watch.action('prepare', { runId: 'r' });
  await f.watch.action('bind', { grant: f.grant });
  await f.watch.action('start');
}

test('retiring legacy ownership never touches playback or routes cleanup to the newly selected policy', async () => {
  const f = fixture();
  await start(f);
  f.rpc.length = 0;
  f.context.settings.bilibiliOwnedRelease = true;
  let writes = 0;
  f.context.video = { pause() { writes++; }, play() { writes++; },
    set currentTime(_) { writes++; }, set playbackRate(_) { writes++; } };
  await f.watch.retire();
  for (let i = 0; i < 10; i++) f.watch.tick();
  assert.equal(writes, 0);
  assert.equal(f.watch.active, false);
  assert.equal(f.watch.grant, null);
  assert.deepEqual(f.rpc.map(row => [row.type, row.action]), [
    ['bilibili-native-supply-host', 'stop'], ['bilibili-native-supply-host', 'cleanup'],
  ]);
  assert.ok(f.rpc.every(row => row.runId === f.grant.runId && row.instanceId === f.grant.instanceId));
});
function demand(id = 'd') { return { id, sourceId: id, originalText: '你好世界', mediaTimeMs: 5000,
  epoch: 1, predictionEpoch: 4, ruleRevision: 5, deadlineAtEpochMs: Date.now() + 4000 }; }
function output(f, id = 'd') { return { id, text: 'こんにちは世界', status: 'translated', nativeSupply: {
  runId: 'r', instanceId: 'i', configIdentity: 'config', resultId: id } }; }

test('retired strict setting stays off and never silently enables ordinary translation', () => {
  assert.equal(DEFAULT_SETTINGS.bilibiliNativeTranslationOnly, false);
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, enabled: false, bilibiliNativeTranslationOnly: true });
  assert.equal(settings.bilibiliNativeTranslationOnly, false);
  assert.equal(settings.bilibiliShadowScheduler, false); assert.equal(settings.enabled, false);
});

test('owned setting is independent, default off, and arming cannot load a model', () => {
  assert.equal(DEFAULT_SETTINGS.bilibiliOwnedRelease, false);
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, bilibiliOwnedRelease: true });
  assert.equal(settings.enabled, false);
  assert.equal(settings.bilibiliNativeTranslationOnly, false);
  assert.equal(settings.bilibiliShadowScheduler, false);
  const f = fixture(); f.context.settings = settings; f.watch.armSetting();
  assert.equal(f.watch.owned, true); assert.equal(f.watch.controlValue().policy, 'owned');
  assert.equal(f.watch.state, 'waiting'); assert.deepEqual(f.rpc, []);
  assert.equal(f.watch.controlValue().state, 'armed');
  assert.equal(f.watch.effectiveSettings().enabled, false);
});

test('owned waiting permits playback, explains conflicting settings, and makes no translation request', async () => {
  const f = fixture();
  f.context.settings = { ...f.context.settings, enabled: true, bilibiliOwnedRelease: true,
    backend: 'local', localModelId: 'chosen' };
  f.context.clock.paused = false;
  f.watch.armSetting();
  for (let i = 0; i < 10; i++) f.watch.tick();
  assert.equal(f.context.clock.paused, false);
  assert.match(f.watch.displayReason, /关闭.*启用翻译/);
  await assert.rejects(f.watch.action('owned-start'), /关闭.*启用翻译/);
  assert.equal(f.watch.waiting, true);
  const output = await f.watch.request([{ id: 'not-started', text: '未开始' }], new AbortController().signal, () => {});
  assert.equal(output[0].reason, 'cancelled');
  assert.deepEqual(f.rpc, []);
  f.context.settings.enabled = false;
  assert.equal(f.watch.startBlocker, '');
  assert.match(f.watch.displayReason, /尚未启动/);
  f.watch.native({ type: 'bilibili-native-supply-event', event: {
    type: 'contractPaused', closed: true, reason: 'native-contract-invalid' } });
  assert.equal(f.watch.state, 'paused');
  assert.equal(f.context.clock.paused, true, 'a real contract fault must still pause');
});

test('owned preparation uses current position, model and languages without seeking or inference', async () => {
  const f = fixture();
  f.context.settings = { ...f.context.settings, bilibiliOwnedRelease: true,
    backend: 'local', localModelId: 'hy-mt2-1-8b', sourceLanguage: 'zh', targetLanguage: 'en', localConcurrency: 3 };
  f.context.clock.mediaTimeMs = 20_000; f.context.video.duration = 187;
  let seeks = 0;
  Object.defineProperty(f.context.video, 'currentTime', { get: () => f.context.clock.mediaTimeMs / 1000,
    set: () => { seeks++; } });
  f.watch.armSetting();
  const page = await f.watch.action('prepare', { runId: 'owned-test' });
  assert.deepEqual(page.range, { fromMs: 20_000, toMs: 187_000 }); assert.equal(seeks, 0);
  assert.deepEqual(f.rpc.map(m => m.type), ['session-open']);
  const effective = f.watch.effectiveSettings();
  assert.equal(effective.localModelId, 'hy-mt2-1-8b'); assert.equal(effective.concurrency, 3);
  assert.equal(effective.sourceLanguage, 'zh'); assert.equal(effective.targetLanguage, 'en');
  assert.equal(effective.bilibiliNativeTranslationOnly, true); assert.equal(effective.bilibiliShadowScheduler, false);
  await assert.rejects(f.watch.action('bind', { grant: f.grant }), /grant-mismatch/);
  const grant = { ...f.grant, ...page.range, policy: 'owned', sourceLanguage: 'zh', targetLanguage: 'en', modelId: 'hy-mt2-1-8b' };
  await f.watch.action('bind', { grant }); await f.watch.action('start');
  assert.equal(f.rpc.at(-1).type, 'bilibili-owned-supply-host');
  assert.equal(f.watch.controlValue().targetLanguage, 'en');
  f.context.settings.bilibiliOwnedRelease = false;
  await f.watch.host('stop'); assert.equal(f.rpc.at(-1).type, 'bilibili-owned-supply-host', 'stop must target the old owner');
  await f.watch.action('cleanup'); assert.equal(f.watch.controlValue(), null);
});

test('owned mode rejects missing model and unknown duration before requesting a permit', async () => {
  const f = fixture(); f.context.settings.bilibiliOwnedRelease = true;
  await assert.rejects(f.watch.action('prepare'), /本地模型/);
  f.context.settings.backend = 'local'; f.context.settings.localModelId = 'chosen';
  f.context.video.duration = Infinity;
  Object.defineProperty(f.context.video, 'currentTime', { get: () => 0 });
  await assert.rejects(f.watch.action('prepare'), /时长明确/);
  assert.deepEqual(f.rpc, []); assert.equal(f.watch.grant, null);
});

test('owned resume rebinds the same task budget; only explicit new-budget rotates the task', async () => {
  const f = fixture();
  f.context.settings = { ...f.context.settings, bilibiliOwnedRelease: true, backend: 'local',
    localModelId: 'chosen-7b', sourceLanguage: 'zh', targetLanguage: 'en' };
  f.context.video.duration = 187;
  Object.defineProperty(f.context.video, 'currentTime', { get: () => f.context.clock.mediaTimeMs / 1000 });
  let persisted = { ...f.grant, policy: 'owned', documentId: 'browser-doc', taskId: 'existing-task',
    runId: 'existing-run', state: 'stopped', reason: 'seek', sourceLanguage: 'zh', targetLanguage: 'en', modelId: 'chosen-7b' };
  f.reply = m => {
    if (m.action === 'status') return { ok: true, grant: { ...persisted } };
    if (m.action === 'stop') persisted.state = 'stopped';
    if (m.action === 'cleanup') persisted.reason = 'cleanup';
    if (m.action === 'prepare' || m.action === 'resume') {
      persisted = { ...persisted, ...m.input, epoch: f.context.epoch, state: 'prepared',
        session: { ...f.context.session }, instanceId: 'new-instance' };
      return { ok: true, grant: { ...persisted } };
    }
    return { ok: true };
  };
  f.watch.armSetting(); f.context.epoch = 2;
  await f.watch.action('owned-start');
  const resume = f.rpc.find(m => m.action === 'resume');
  assert.equal(resume.type, 'bilibili-owned-supply-host');
  assert.equal(resume.input.taskId, 'existing-task'); assert.equal(resume.input.runId, 'existing-run');
  assert.equal(resume.input.epoch, 2); assert.equal(resume.input.authorizedNewBudget, undefined);
  assert.equal(f.watch.running, true);
  f.watch.pause('manual');
  await f.watch.action('owned-start', { newBudget: true });
  const prepare = f.rpc.findLast(m => m.action === 'prepare');
  assert.equal(prepare.input.authorizedNewBudget, true);
  assert.notEqual(prepare.input.taskId, 'existing-task');
  const lastCleanup = f.rpc.findLastIndex(m => m.action === 'cleanup');
  assert.ok(lastCleanup < f.rpc.findLastIndex(m => m.action === 'prepare'));
  assert.equal(f.watch.running, true);
});

test('owned budget cutoff stops new demand and drains for a bounded time before pausing', async () => {
  const f = fixture();
  f.context.settings = { ...f.context.settings, bilibiliOwnedRelease: true, backend: 'local', localModelId: 'chosen' };
  f.context.video.duration = 300;
  Object.defineProperty(f.context.video, 'currentTime', { get: () => f.context.clock.mediaTimeMs / 1000 });
  f.watch.armSetting(); await f.watch.action('prepare', { runId: 'r' });
  await f.watch.action('bind', { grant: { ...f.grant, toMs: 300000, policy: 'owned', modelId: 'chosen',
    sourceLanguage: f.context.settings.sourceLanguage, targetLanguage: f.context.settings.targetLanguage } });
  await f.watch.action('start'); f.demands = [demand()];
  f.reply = m => m.action === 'translate' ? { ok: true, items: [], budgetExhausted: true, budgetReason: 'limit-reached' } : { ok: true };
  await f.watch.request([{ ...f.demands[0], text: f.demands[0].originalText }], new AbortController().signal, () => {});
  assert.equal(f.watch.state, 'draining'); assert.equal(f.watch.controlValue().state, 'running');
  const before = f.rpc.filter(m => m.action === 'translate').length;
  const outputs = await f.watch.request([{ ...f.demands[0], text: f.demands[0].originalText }], new AbortController().signal, () => {});
  assert.equal(outputs[0].reason, 'cancelled'); assert.equal(f.rpc.filter(m => m.action === 'translate').length, before);
  f.context.clock.mediaTimeMs = 7001; f.watch.tick();
  assert.equal(f.watch.state, 'paused'); assert.equal(f.context.clock.paused, true);
});

test('first owned new-budget action creates the initial task without requesting ledger replacement', async () => {
  const f = fixture();
  f.context.settings = { ...f.context.settings, bilibiliOwnedRelease: true, backend: 'local', localModelId: 'chosen' };
  f.context.video.duration = 300;
  Object.defineProperty(f.context.video, 'currentTime', { get: () => 0 });
  f.reply = m => {
    if (m.action === 'status') return { ok: true, grant: null };
    if (m.action === 'prepare') return { ok: true, grant: { ...f.grant, ...m.input,
      policy: 'owned', modelId: 'chosen', sourceLanguage: f.context.settings.sourceLanguage,
      targetLanguage: f.context.settings.targetLanguage } };
    return { ok: true };
  };
  await f.watch.action('owned-start', { newBudget: true });
  const prepare = f.rpc.find(m => m.action === 'prepare');
  assert.equal(prepare.input.authorizedNewBudget, undefined);
  assert.equal(f.rpc.some(m => m.action === 'cleanup' || m.action === 'resume'), false);
  assert.equal(f.watch.running, true);
});
test('arming is zero-call; prepare/bind/start keep scheduler identity stable', async () => {
  const f = fixture(); f.watch.armSetting(); assert.equal(f.rpc.length, 0); assert.equal(f.watch.state, 'paused');
  await start(f);
  assert.deepEqual(f.configured[0], f.configured[1]); assert.deepEqual(f.configured[1], f.configured[2]);
  assert.deepEqual(f.rpc.filter(x => x.type === 'bilibili-native-supply-host').map(x => x.action), ['start']); assert.equal(f.context.clock.paused, false);
});
test('per-item qualified provenance reaches MAIN; unsupported provenance cannot prepare', async () => {
  const f = fixture(); await start(f); const d = demand(); f.demands = [d];
  let resolve;
  f.reply = m => m.action === 'translate' ? new Promise(r => { resolve = r; }) : { ok: true };
  const task = f.watch.request([{ ...d, text: d.originalText }], new AbortController().signal, o => f.received.push(o));
  const request = f.rpc.at(-1);
  f.watch.acceptResult(request.requestId, { ...output(f), nativeSupply: { ...output(f).nativeSupply, configIdentity: 'wrong' } });
  assert.equal(f.received.length, 0);
  f.watch.acceptResult(request.requestId, output(f)); assert.equal(f.received.length, 1);
  f.watch.prepared([{ ...d, text: output(f).text, status: 'translated' }]);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].nativeSupply, true);
  assert.equal(f.sent[0].items[0].sourceId, 'd'); assert.equal(f.sent[0].items[0].configIdentity, 'config');
  resolve({ ok: true, items: [output(f)] }); await task;
});
test('old epoch and late callback cannot revive event; pause leaves strict gate installed', async () => {
  const f = fixture(); await start(f); const d = demand(); f.demands = [d];
  let resolve; f.reply = m => m.action === 'translate' ? new Promise(r => { resolve = r; }) : { ok: true };
  const task = f.watch.request([{ ...d, text: d.originalText }], new AbortController().signal, o => f.received.push(o));
  const id = f.rpc.at(-1).requestId; f.context.epoch = 2; f.watch.tick();
  f.watch.acceptResult(id, output(f)); resolve({ ok: true, items: [output(f)] }); await task;
  assert.equal(f.received.length, 0); assert.equal(f.watch.state, 'paused');
  assert.equal(f.watch.controlValue().enabled, true); assert.equal(f.watch.controlValue().state, 'paused');
});
test('closing missed predictions uses original identity; cancelling one subscription preserves its peer', async () => {
  const f = fixture(); await start(f); const one = demand('a'), two = demand('b'); f.demands = [one, two];
  let resolve; f.reply = m => m.action === 'translate' ? new Promise(r => { resolve = r; }) : { ok: true };
  const signal = new AbortController().signal;
  const task = f.watch.request([one,two].map(d => ({ ...d, text: d.originalText })), signal, o => f.received.push(o));
  const id = f.rpc.at(-1).requestId; f.watch.cancelItems(signal, ['a']);
  assert.deepEqual(f.rpc.at(-1).ids, ['a']);
  f.watch.acceptResult(id, output(f,'a')); f.watch.acceptResult(id, output(f,'b'));
  assert.deepEqual(f.received.map(o => o.id), ['b']);
  f.watch.native({ type: 'bilibili-native-supply-event', event: { id: 'miss', epoch: 1, predictionEpoch: 4, type: 'suppressed', closed: true } });
  assert.equal(f.closed[0][1], '未预测内容');
  resolve({ ok: true, items: [] }); await task;
});

test('cleanup under saved strict setting preserves paused gate until explicit disable', async () => {
  const f = fixture(); f.context.settings.bilibiliNativeTranslationOnly = true;
  await start(f); await f.watch.action('cleanup');
  assert.equal(f.watch.controlValue().enabled, true); assert.equal(f.watch.controlValue().state, 'paused');
  assert.equal(f.context.clock.paused, true);
  f.context.settings.bilibiliNativeTranslationOnly = false;
  await f.watch.action('cleanup'); assert.equal(f.watch.controlValue(), null);
});

test('full-video reference keeps playing beyond 52s and snapshots never open a model permit or pause', async () => {
  const f = fixture();
  f.context.video.duration = 183;
  f.context.video.ended = false;
  Object.defineProperty(f.context.video, 'currentTime', { configurable: true,
    get: () => f.context.clock.mediaTimeMs / 1000,
    set: value => { f.context.clock.mediaTimeMs = value * 1000; } });
  const started = await f.watch.action('reference-full-start');
  assert.equal(started.reference.durationMs, 183000);
  assert.equal(started.reference.fullVideo, true);
  assert.equal(f.watch.active, false);
  assert.equal(f.watch.controlValue(), null);
  f.context.clock.mediaTimeMs = 90000; f.watch.tick();
  assert.equal(f.context.clock.paused, false);
  f.watch.native({ type: 'bilibili-shadow', known: true, items: [{ id: 'own', originalText: '原文',
    reasons: ['user-rule-coverage-incomplete'] }] });
  const snapshot = await f.watch.action('reference-snapshot');
  assert.equal(f.context.clock.paused, false);
  assert.equal(snapshot.reference.samples[0].mediaTimeMs, 90000);
  assert.equal(snapshot.reference.forecasts[0].items[0].reasons[0], 'user-rule-coverage-incomplete');
  assert.equal(f.configured[0].enabled, false);
  assert.equal(f.configured[0].bilibiliNativeTranslationOnly, false);
  assert.deepEqual(f.rpc, []);
  assert.deepEqual(f.sent, []);
  await f.watch.action('reference-stop');
  assert.equal(f.context.clock.paused, true);
  assert.equal(f.watch.referenceFullVideo, false);
  await assert.rejects(f.watch.action('reference-snapshot'), /not-running/);
});

test('legacy reference still stops at 52s and full-video reference rejects unbounded duration', async () => {
  const f = fixture();
  f.context.video.duration = Infinity;
  await assert.rejects(f.watch.action('reference-full-start'), /duration-unavailable/);
  assert.equal(f.watch.reference, false);
  await f.watch.action('reference-start');
  f.context.clock.mediaTimeMs = 52001; f.watch.tick();
  assert.equal(f.context.clock.paused, true);
  assert.deepEqual(f.rpc, []);
});

test('reference readiness registers the exact document before the zero-transport guard, without model actions', async () => {
  const f = fixture();
  f.context.clock.paused = false;
  const reply = await f.watch.action('reference-ready');
  assert.equal(reply.ok, true);
  assert.equal(reply.clock.paused, true);
  assert.deepEqual(f.rpc, [{ type: 'session-open', session: f.context.session }]);
  assert.equal(f.watch.reference, false);
  assert.equal(f.watch.active, false);
  assert.deepEqual(f.configured, []);
  f.reply = () => ({ ok: false });
  await assert.rejects(f.watch.action('reference-ready'), /session-unavailable/);
});

test('official observation installs before seeking, exports without pausing, and confirms preTime restoration', async () => {
  for (const [action, mode, requested] of [
    ['reference-official-1-start', 'native-1', 1],
    ['reference-official-3-start', 'native-3', 3],
    ['reference-official-5-start', 'native-5', 5],
    ['reference-official-dom-start', 'dom', null],
  ]) {
    const f = fixture(), order = [];
    f.context.video.duration = 10;
    f.context.clock.mediaTimeMs = 4000;
    f.context.snapshotAt = 1;
    Object.defineProperty(f.context.video, 'currentTime', {
      get: () => f.context.clock.mediaTimeMs / 1000,
      set: value => { order.push('seek'); f.context.clock.mediaTimeMs = value * 1000;
        f.context.snapshotAt++; },
    });
    f.onControl = extra => {
      const official = f.watch.officialObservationValue();
      if (!official) return;
      order.push(extra?.officialObservationStop ? 'stop' : extra?.officialObservationExport ? 'export' : 'observe');
      const restored = extra?.officialObservationStop === true;
      f.watch.native({ type: 'bilibili-official-observation', report: {
        ...official, ready: true, preTime: { original: 0, current: restored ? 0 : requested ?? 0,
          requested, restored }, methodHooks: !restored && mode !== 'dom',
        events: [{ type: 'nativeFetch', atEpochMs: Date.now() }], dom: [], sourcePool: [],
        metadata: {}, settingsEvidence: {}, capacityExceeded: false, instrumentationErrors: 0,
      } });
    };
    const started = await f.watch.action(action);
    assert.deepEqual(order.slice(0, 3), ['observe', 'seek', 'export']);
    assert.equal(started.official.mode, mode);
    assert.equal(started.officialReport.preTime.requested, requested);
    assert.equal(f.context.clock.paused, false);
    assert.equal(f.configured[0].enabled, false);
    assert.equal(f.configured[0].bilibiliShadowScheduler, false);
    const snapshot = await f.watch.action('reference-snapshot');
    assert.equal(snapshot.officialReport.events.length, 1);
    assert.equal(f.context.clock.paused, false, 'snapshot must not pause playback');
    const stopped = await f.watch.action('reference-stop');
    assert.equal(stopped.officialReport.preTime.restored, true);
    assert.equal(stopped.officialReport.methodHooks, false);
    assert.equal(f.context.clock.paused, true);
    assert.equal(f.watch.officialObservationValue(), null);
    assert.equal(f.controls.at(-1).official, null);
    assert.deepEqual(f.rpc, [{ type: 'session-open', session: f.context.session }]);
  }
});

test('official post-seek waits for a fresh epoch snapshot and retries read-only export until acknowledged', async () => {
  const f = fixture(), order = [];
  f.context.video.duration = 10;
  f.context.clock.mediaTimeMs = 0;
  f.context.snapshotAt = 4;
  let exports = 0;
  Object.defineProperty(f.context.video, 'currentTime', {
    get: () => f.context.clock.mediaTimeMs / 1000,
    set: value => {
      order.push('seek'); f.context.video.seeking = true; f.context.clock.seeking = true;
      f.context.clock.mediaTimeMs = value * 1000;
      setTimeout(() => {
        f.context.epoch = 2; f.context.snapshotAt = 5;
        f.context.video.seeking = false; f.context.clock.seeking = false;
        order.push('fresh-snapshot');
      }, 150);
    },
  });
  const play = f.context.video.play;
  f.context.video.play = async () => { order.push('play'); await play(); };
  f.onControl = extra => {
    const official = f.watch.officialObservationValue();
    if (!official) return;
    if (extra?.officialObservationExport) {
      exports++;
      order.push(`export-${exports}-epoch-${f.context.epoch}`);
      if (exports === 1) return; // MAIN's response used the pre-seek epoch and was discarded.
    }
    const stopped = extra?.officialObservationStop === true;
    f.watch.native({ type: 'bilibili-official-observation', report: {
      ...official, ready: true, error: null,
      preTime: { original: 0, current: stopped ? 0 : 1, requested: 1, restored: stopped },
      methodHooks: !stopped, events: [], dom: [], sourcePool: [],
      metadata: {}, settingsEvidence: {}, capacityExceeded: false, instrumentationErrors: 0,
    } });
  };
  const started = await f.watch.action('reference-official-1-start');
  assert.equal(started.epoch, 2);
  assert.equal(started.officialReport.ready, true);
  assert.equal(exports, 2, 'the lost post-seek export must be requested again');
  assert.ok(order.indexOf('fresh-snapshot') < order.indexOf('export-1-epoch-2'));
  assert.ok(order.indexOf('export-2-epoch-2') < order.indexOf('play'));
  assert.equal(f.context.clock.paused, false);
  assert.equal(f.rpc.length, 1);
  await f.watch.action('reference-stop');
});
