import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoScheduler } from '../../src/core/scheduler.ts';
import { DEFAULT_SETTINGS } from '../../src/core/config.ts';

const source = (id, text = `これは${id}です`, mediaTimeMs = 5000) => ({
  id, sourceId: id, resourceId: 'video', platform: 'bilibili', originalText: text,
  mediaTimeMs, renderAtMs: mediaTimeMs - 1000, translatable: true, style: { commands: [] },
});
const clock = (mediaTimeMs = 0, playbackRate = 1) => ({ mediaTimeMs, durationMs: 60_000,
  playbackRate, paused: false, seeking: false, contentActive: true });
const selection = (row, deadlineAtEpochMs = 105_000) => ({ id: row.id, sourceId: row.sourceId,
  originalText: row.originalText, stimeMs: row.mediaTimeMs, deadlineAtEpochMs, reasons: [] });
const update = (revision, rows, extra = {}) => ({ epoch: 0, revision, policy: 'owned',
  active: true, known: true, predictionEpoch: 0, ruleRevision: 1,
  sampledAtEpochMs: 100_000, playbackRate: 1, items: rows.map(row => selection(row)), ...extra });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('hybrid submits bounded planning packets independently of one local provider slot', t => {
  const h = plannedHarness({ backend: 'local', concurrency: 1, batchSize: 1,
    maxBatchChars: 24000, bilibiliHybrid: { enabled: true, profiles: [] } });
  t.after(() => h.scheduler.dispose());
  const rows = Array.from({ length: 201 }, (_, i) => source(`hybrid-${i}`));
  h.scheduler.snapshot('video', 'session', clock(), rows, 0);
  h.scheduler.updateShadow(update(1, rows));
  assert.deepEqual(h.calls.map(call => call.items.length), [200, 1]);
  assert.equal(h.calls.every(call => call.items.every(item => item.remainingMs === 5000)), true);
});

test('online hybrid results retain online quality semantics when the ordinary backend is local', t => {
  const h = plannedHarness({ backend: 'local', targetLanguage: 'ja', localPerformance: { languageValidation: 'strict' },
    bilibiliHybrid: { enabled: true, profiles: [] } });
  t.after(() => h.scheduler.dispose());
  const row = source('online', 'これは元の文です');
  h.scheduler.snapshot('video', 'session', clock(), [row], 0);
  h.scheduler.updateShadow(update(1, [row]));
  h.calls[0].onResult({ id: row.id, backend: 'online', status: 'translated', text: 'one two three' });
  assert.equal(h.prepared.length, 1, 'the local-only script validator does not reject an online result');
});

function plannedHarness(settings = {}) {
  let now = 0, epochNow = 100_000;
  const calls = [], prepared = [], removed = [], cancelled = [];
  const scheduler = new VideoScheduler({ settings: { ...DEFAULT_SETTINGS, enabled: true,
    bilibiliOwnedRelease: true, bilibiliNativeTranslationOnly: false, targetLanguage: 'en',
    videoBatchSize: 2, ...settings },
  now: () => now, nowEpochMs: () => epochNow, reset() {},
  prepared: items => prepared.push(...items), removed: ids => removed.push(...ids),
  cancelItems: (_signal, ids) => cancelled.push(...ids),
  request: (_resource, items, signal, _priority, onResult) => new Promise(resolve =>
    calls.push({ items, signal, onResult, resolve })) });
  return { scheduler, calls, prepared, removed, cancelled,
    advance(ms) { now += ms; epochNow += ms; } };
}

test('owned flag alone admits only exact five-second selected events and fills every subscription field', async t => {
  const h = plannedHarness(); t.after(() => h.scheduler.dispose());
  const a = source('a'), out = source('out', undefined, 11_000);
  h.scheduler.snapshot('video', 'session', clock(), [a, out], 0);
  assert.equal(h.calls.length, 0);
  h.scheduler.updateShadow({ ...update(1, [a]), policy: 'native' });
  assert.equal(h.calls.length, 0, 'an official forecast cannot authorize an owned subscription');
  h.scheduler.updateShadow(update(2, [{ ...a, sourceId: 'wrong' }]));
  assert.equal(h.calls.length, 0, 'source identity is checked against the selected native event');
  h.scheduler.updateShadow(update(3, [a, out]));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].items.length, 1);
  const due = h.calls[0].items[0];
  assert.deepEqual({ id: due.id, text: due.text, sourceId: due.sourceId, epoch: due.epoch,
    predictionEpoch: due.predictionEpoch, ruleRevision: due.ruleRevision,
    deadlineAtEpochMs: due.deadlineAtEpochMs, remainingMs: due.remainingMs },
  { id: a.id, text: a.originalText, sourceId: a.sourceId, epoch: 0,
    predictionEpoch: 0, ruleRevision: 1, deadlineAtEpochMs: 105_000, remainingMs: 5000 });
  assert.equal(typeof due.configIdentity, 'string');
  assert.deepEqual(h.scheduler.currentNativeDemand().map(row => row.id), ['a']);
  h.calls[0].onResult({ id: 'a', status: 'cached', text: 'Translated A' });
  assert.deepEqual(h.prepared, [{ id: 'a', text: 'Translated A', originalText: a.originalText,
    sourceId: 'a', status: 'cached', epoch: 0, predictionEpoch: 0, ruleRevision: 1,
    deadlineAtEpochMs: 105_000, configIdentity: due.configIdentity }]);
  h.calls[0].resolve([]); await flush();
  assert.equal(h.calls.length, 1);
});

test('owned shared batch cancels only retired subscribers; unchanged cached text never becomes prepared', async t => {
  const h = plannedHarness(); t.after(() => h.scheduler.dispose());
  const a = source('a'), b = source('b');
  h.scheduler.snapshot('video', 'session', clock(), [a, b], 0);
  h.scheduler.updateShadow(update(1, [a, b]));
  assert.deepEqual(h.calls[0].items.map(row => row.id), ['a', 'b']);
  assert.equal(h.scheduler.closeNativeEvent('a', a.originalText, 0, 0, 'missed'), true);
  assert.equal(h.calls[0].signal.aborted, false);
  assert.deepEqual(h.cancelled, ['a']);
  h.calls[0].onResult({ id: 'a', status: 'translated', text: 'late A' });
  h.calls[0].onResult({ id: 'b', status: 'cached', text: b.originalText });
  h.calls[0].resolve([{ id: 'b', status: 'cached', text: b.originalText }]); await flush();
  assert.deepEqual(h.prepared, []);
  assert.equal(h.calls.length, 1, 'strict subscriptions are not retried after one attempt');
  assert.deepEqual(h.scheduler.currentNativeDemand().map(row => row.id), ['b']);
});

test('owned rule, playback epoch and selection revocation discard stale results without retry', async t => {
  const h = plannedHarness({ videoBatchSize: 1, concurrency: 2 }); t.after(() => h.scheduler.dispose());
  const a = source('a'), b = source('b');
  h.scheduler.snapshot('video', 'session', clock(), [a, b], 0);
  h.scheduler.updateShadow(update(1, [a, b]));
  assert.equal(h.calls.length, 2);
  h.scheduler.updateShadow(update(2, [b]));
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.calls[1].signal.aborted, false);
  h.calls[0].onResult({ id: 'a', status: 'translated', text: 'stale A' });
  h.calls[1].onResult({ id: 'b', status: 'translated', text: 'Translated B' });
  assert.deepEqual(h.prepared.map(row => row.id), ['b']);
  h.removed.length = 0;
  h.scheduler.updateShadow(update(3, [a, b], { ruleRevision: 2 }));
  assert.equal(h.calls[1].signal.aborted, true);
  assert.deepEqual(h.removed, ['b']);
  assert.equal(h.calls.length, 2, 'rules cannot revive previously attempted events');
  h.scheduler.snapshot('video', 'session', clock(), undefined, 1);
  assert.deepEqual(h.scheduler.currentNativeDemand(), []);
  h.calls[0].resolve([]); h.calls[1].resolve([]); await flush();
  assert.deepEqual(h.prepared.map(row => row.id), ['b']);
});

test('unplanned ordinary Bilibili keeps its existing translation path and unchanged cache behavior', async t => {
  const h = plannedHarness({ bilibiliOwnedRelease: false }); t.after(() => h.scheduler.dispose());
  const a = source('a');
  h.scheduler.snapshot('video', 'session', clock(), [a], 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].items[0].predictionEpoch, undefined);
  h.calls[0].onResult({ id: 'a', status: 'cached', text: a.originalText });
  assert.equal(h.prepared[0].text, a.originalText);
  assert.equal(h.prepared[0].predictionEpoch, undefined);
  h.calls[0].resolve([]); await flush();
});

test('owned local results obey existing target-language quality checks for both cached and translated output', async t => {
  const h = plannedHarness({ backend: 'local', localModelId: 'selected',
    localPerformance: { languageValidation: 'strict' } });
  t.after(() => h.scheduler.dispose());
  const a = source('a');
  h.scheduler.snapshot('video', 'session', clock(), [a], 0);
  h.scheduler.updateShadow(update(1, [a]));
  h.calls[0].onResult({ id: 'a', status: 'cached', text: 'これは翻訳ではありません' });
  assert.equal(h.prepared.length, 0);
  h.calls[0].resolve([{ id: 'a', status: 'translated', text: 'これは英語ではありません' }]);
  await flush();
  assert.equal(h.prepared.length, 0);
  assert.equal(h.calls.length, 1);
});

test('planned background visibility and seek revoke current subscriptions without accepting callbacks', async t => {
  for (const patch of [{ contentActive: false }, { seeking: true }, { commentsVisible: false }]) {
    const h = plannedHarness(); t.after(() => h.scheduler.dispose());
    const a = source('a');
    h.scheduler.snapshot('video', 'session', clock(), [a], 0);
    h.scheduler.updateShadow(update(1, [a]));
    h.scheduler.snapshot('video', 'session', { ...clock(), ...patch }, undefined, 0);
    assert.equal(h.calls[0].signal.aborted, true);
    h.calls[0].onResult({ id: 'a', status: 'translated', text: 'Stale translation' });
    assert.equal(h.prepared.length, 0);
    h.calls[0].resolve([]); await flush();
  }
});

test('planned list retains a five-second scope even if ordinary automatic scope knows a filtered pool', t => {
  const h = plannedHarness({ translationScope: 'auto' }); t.after(() => h.scheduler.dispose());
  const a = source('a');
  h.scheduler.snapshot('video', 'session', clock(), [a], 0);
  h.scheduler.updateEligibility({ epoch: 0, revision: 1, reset: true, capability: 'filtered-pool', display: 'visible', items: [] });
  h.scheduler.updateShadow(update(1, [a]));
  assert.equal(h.calls.length, 1);
  assert.equal(h.scheduler.getStats().effectiveScope, 'window');
});

test('a changed planned language waits for a new list and may subscribe under its new configuration', t => {
  const h = plannedHarness(); t.after(() => h.scheduler.dispose());
  const a = source('a');
  h.scheduler.snapshot('video', 'session', clock(), [a], 0);
  h.scheduler.updateShadow(update(1, [a]));
  h.scheduler.configure({ ...DEFAULT_SETTINGS, enabled: true, bilibiliOwnedRelease: true, targetLanguage: 'fr' });
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.calls.length, 1, 'the previous plan cannot authorize a new configuration');
  h.scheduler.updateShadow(update(2, [a], { predictionEpoch: 1 }));
  assert.equal(h.calls.length, 2);
  assert.notEqual(h.calls[0].items[0].configIdentity, h.calls[1].items[0].configIdentity);
});

test('planned online cached and fresh output cannot lose protected placeholders', async t => {
  const h = plannedHarness({ backend: 'online' }); t.after(() => h.scheduler.dispose());
  const a = source('a', 'これは[[DL:keep]]です');
  h.scheduler.snapshot('video', 'session', clock(), [a], 0);
  h.scheduler.updateShadow(update(1, [a]));
  h.calls[0].onResult({ id: 'a', status: 'cached', text: 'Missing protected text' });
  h.calls[0].resolve([{ id: 'a', status: 'translated', text: 'Missing protected text' }]);
  await flush();
  assert.equal(h.prepared.length, 0);
});

test('owned pause retains prepared results, holds new subscriptions, and does not resend on resume', async t => {
  const h = plannedHarness({ videoBatchSize: 1, concurrency: 1 });
  t.after(() => h.scheduler.dispose());
  const a = source('a'), b = source('b');
  h.scheduler.snapshot('video', 'session', clock(), [a, b], 0);
  h.scheduler.updateShadow(update(1, [a, b]));
  assert.equal(h.calls.length, 1);
  h.calls[0].onResult({ id: 'a', status: 'translated', text: 'Prepared A' });
  h.removed.length = 0;
  h.scheduler.snapshot('video', 'session', { ...clock(), paused: true }, undefined, 0);
  h.scheduler.updateShadow(update(2, [a, b], { suspended: true }));
  h.calls[0].resolve([]); await flush();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.scheduler.currentNativeDemand(), []);
  h.advance(60_000);
  h.scheduler.updateShadow(update(3, [], { suspended: true, sampledAtEpochMs: 160_000,
    items: [selection(a, 165_000), selection(b, 165_000)] }));
  assert.equal(h.scheduler.getStats().nearPrepared, 1);
  assert.deepEqual(h.removed, []);
  assert.equal(h.prepared.length, 1);
  h.scheduler.updateShadow(update(4, [], { suspended: false, sampledAtEpochMs: 160_000,
    items: [selection(a, 165_000), selection(b, 165_000)] }));
  assert.equal(h.calls.length, 1, 'the paused clock also guards update-before-snapshot ordering');
  h.scheduler.snapshot('video', 'session', clock(), undefined, 0);
  assert.deepEqual(h.calls.map(call => call.items[0].id), ['a', 'b']);
  assert.equal(h.calls[1].items[0].remainingMs, 5000);
  h.calls[1].resolve([]); await flush();
});

test('owned suspension before the paused clock arrives blocks dispatch but keeps finite inflight delivery', async t => {
  const h = plannedHarness(); t.after(() => h.scheduler.dispose());
  const a = source('a'), b = source('b');
  h.scheduler.snapshot('video', 'session', clock(), [a, b], 0);
  h.scheduler.updateShadow(update(1, [a]));
  h.scheduler.updateShadow(update(2, [a, b], { suspended: true }));
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.scheduler.currentNativeDemand(), []);
  h.calls[0].onResult({ id: 'a', status: 'translated', text: 'Prepared while paused' });
  assert.equal(h.prepared.length, 1);
  h.calls[0].resolve([]); await flush();
  assert.equal(h.calls.length, 1);
});

test('pause never extends an already issued request deadline or revives its late result', async t => {
  const h = plannedHarness(); t.after(() => h.scheduler.dispose());
  const a = source('a');
  h.scheduler.snapshot('video', 'session', clock(), [a], 0);
  h.scheduler.updateShadow(update(1, [a]));
  h.scheduler.snapshot('video', 'session', { ...clock(), paused: true }, undefined, 0);
  h.scheduler.updateShadow(update(2, [a], { suspended: true }));
  h.advance(6000);
  h.scheduler.updateShadow(update(3, [], { suspended: true, sampledAtEpochMs: 106_000,
    items: [selection(a, 111_000)] }));
  h.calls[0].onResult({ id: 'a', status: 'translated', text: 'Too late' });
  h.calls[0].resolve([{ id: 'a', status: 'translated', text: 'Too late' }]); await flush();
  assert.equal(h.prepared.length, 0);
  h.scheduler.updateShadow(update(4, [], { sampledAtEpochMs: 106_000, items: [selection(a, 111_000)] }));
  h.scheduler.snapshot('video', 'session', clock(), undefined, 0);
  assert.equal(h.calls.length, 1);
});
