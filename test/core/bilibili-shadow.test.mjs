import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastBilibiliShadow, nativeShadowIndex, nativeShadowRange, shadowValidateLimit, parseBilibiliShadowUpdate } from '../../src/core/bilibili-shadow.ts';
import { VideoScheduler } from '../../src/core/scheduler.ts';
import { DEFAULT_SETTINGS } from '../../src/core/config.ts';

const item = (dmid, stime, extras = {}) => ({ dmid, stime, text: 'これは原文です', mode: 1, rawMode: 1, pool: 0, on: false, ...extras });
const input = list => ({ list, currentTime: 10, renderTime: 10, lastFetchTime: 10, lastTime: 10.999,
  preTime: 1, videoSpeed: 1, cadenceSeconds: 1.01, area: 100, height: 280, fontSize: 1, limit: 300,
  match: () => ({ state: 'retain', reason: 'allowed' }) });

test('owned supply wire cannot be mistaken for an official forecast', () => {
  const update = { epoch: 0, revision: 1, active: true, known: true, items: [], policy: 'owned' };
  assert.equal(parseBilibiliShadowUpdate(update).policy, 'owned');
  assert.equal(parseBilibiliShadowUpdate({ ...update, policy: 'unknown' }), null);
  const scheduler = new VideoScheduler({ settings: { ...DEFAULT_SETTINGS, bilibiliOwnedRelease: true },
    reset() {}, request: async () => { throw Error('must not dispatch'); } });
  scheduler.snapshot('video', 'session', { mediaTimeMs: 0, durationMs: 60_000, playbackRate: 1,
    paused: false, seeking: false, contentActive: true }, [], 0);
  scheduler.updateShadow({ ...update, policy: 'native' });
  assert.equal(scheduler.shadowRevision, -1);
  scheduler.updateShadow(update); assert.equal(scheduler.shadowRevision, 1);
  scheduler.dispose();
});

test('native equal-boundary search retains native midpoint behavior and original list order', () => {
  const list = [item('1', 1), item('2', 1), item('3', 1), item('4', 2)];
  assert.equal(nativeShadowIndex(list, 1), 2); // Not an upper bound at index 3.
  assert.deepEqual(nativeShadowRange(list, 1, 1.5).map(row => row.dmid), ['3']);
  assert.equal(nativeShadowIndex([], 1), 0);
});

test('forecast selects in native one-second batches through a five-second horizon without mutating inputs', () => {
  const list = [item('1', 11.3), item('2', 12.5), item('3', 14.7), item('4', 15.2)];
  const before = JSON.stringify(list);
  const result = forecastBilibiliShadow(input(list));
  assert.deepEqual(result.selected.map(row => row.item.dmid), ['1', '2', '3']);
  assert.ok(result.selected.find(row => row.item.dmid === '3').predictedInitMs < 14700);
  assert.equal(JSON.stringify(list), before);
});

test('active items consume validate quota before on rejection, likes only bypass the later roll cap', () => {
  const result = forecastBilibiliShadow({ ...input([item('1', 11.2, { on: true }), item('2', 11.3, { likes: {} })]), limit: 5 });
  assert.equal(result.selected.length, 0);
  assert.equal(result.rejected.on, 1);
  assert.equal(result.rejected.limit, 1);
  const capped = forecastBilibiliShadow({ ...input([item('1', 11.2), item('2', 11.3), item('3', 11.4, { likes: {} })]), height: 20 });
  assert.deepEqual(capped.selected.map(row => row.item.dmid), ['1', '3']);
  assert.equal(capped.rejected['roll-cap'], 1);
});

test('strict 1000ms quota boundary and pool exemptions do not share visible-count semantics', () => {
  const state = { start: 0, count: 0 };
  assert.equal(shadowValidateLimit(state, 100, 5, 0), true);
  assert.equal(shadowValidateLimit(state, 1100, 5, 0), false);
  assert.equal(shadowValidateLimit(state, 1101, 5, 0), true);
  assert.equal(shadowValidateLimit(state, 1102, 5, 1), true);
  assert.equal(shadowValidateLimit(state, 1103, -1, 0), true);
  assert.equal(shadowValidateLimit(state, 1104, 5, 0), false);
});

test('blocked rows do not consume quota and uncertainty is retained in the prediction evidence', () => {
  const result = forecastBilibiliShadow({ ...input([item('1', 11.2), item('2', 11.3)]), limit: 5,
    match: row => row.dmid === '1' ? { state: 'exclude', reason: 'weight' } : { state: 'unknown', reason: 'report-filter-unavailable' } });
  assert.deepEqual(result.selected.map(row => row.item.dmid), ['2']);
  assert.deepEqual(result.selected[0].reasons, ['report-filter-unavailable']);
});

test('shadow bridge parser rejects duplicate IDs and malformed source identity', () => {
  const v = { epoch: 0, revision: 1, active: true, known: true, items: [{ id: 'a', originalText: '原文' }] };
  assert.deepEqual(parseBilibiliShadowUpdate(v), v);
  assert.equal(parseBilibiliShadowUpdate({ ...v, items: [...v.items, ...v.items] }), null);
  assert.equal(parseBilibiliShadowUpdate({ ...v, epoch: -1 }), null);
  const strict = { ...v, predictionEpoch: 2, ruleRevision: 3, sampledAtEpochMs: 100_000,
    playbackRate: 2, items: [{ ...v.items[0], sourceId: '42', stimeMs: 5000,
      deadlineAtEpochMs: 102_500, reasons: ['report-filter-unavailable'] }] };
  assert.deepEqual(parseBilibiliShadowUpdate(strict), strict);
  assert.equal(parseBilibiliShadowUpdate({ ...strict, items: [{ ...strict.items[0],
    deadlineAtEpochMs: Infinity }] }), null);
  assert.equal(parseBilibiliShadowUpdate({ ...strict, items: [{ ...strict.items[0], reasons: [42] }] }), null);
});

test('translation admission requires a fresh matching shadow selection and rejects stale results after revocation', () => {
  const requests = [], prepared = []; let now = 0;
  const scheduler = new VideoScheduler({ settings: { ...DEFAULT_SETTINGS, enabled: true, bilibiliShadowScheduler: true, targetLanguage: 'en', translationScope: 'all' },
    now: () => now, reset() {}, prepared: rows => prepared.push(...rows),
    request: (_resource, items, signal, _priority, onResult) => new Promise(resolve => requests.push({ items, signal, onResult, resolve })) });
  const source = { id: 'a', sourceId: '1', resourceId: 'video', platform: 'bilibili', originalText: 'これはテストです',
    mediaTimeMs: 5000, renderAtMs: 5000, translatable: true, style: { commands: [] } };
  scheduler.snapshot('video', 'session', { mediaTimeMs: 0, durationMs: 60000, playbackRate: 1,
    paused: false, seeking: false, contentActive: true }, [source], 0);
  assert.equal(requests.length, 0);
  scheduler.updateShadow({ epoch: 1, revision: 1, active: true, known: true, items: [{ id: 'a', originalText: source.originalText }] });
  assert.equal(requests.length, 0);
  scheduler.updateShadow({ epoch: 0, revision: 1, active: true, known: true, items: [{ id: 'a', originalText: source.originalText }] });
  assert.equal(requests.length, 1);
  scheduler.updateShadow({ epoch: 0, revision: 2, active: true, known: false, items: [] });
  assert.equal(requests[0].signal.aborted, true);
  requests[0].onResult({ id: 'a', status: 'translated', text: 'translated' });
  assert.equal(prepared.length, 0);
  scheduler.updateShadow({ epoch: 0, revision: 3, active: true, known: true, items: [{ id: 'a', originalText: source.originalText }] });
  assert.equal(requests.length, 2);
  now = 1601; scheduler.tick();
  assert.equal(requests[1].signal.aborted, true);
  scheduler.dispose();
});

test('strict scheduler binds the deadline, event and rule generation and closes only one shared subscription', async () => {
  let now = 0, epochNow = 100_000;
  const calls = [], prepared = [], removed = [], cancelled = [];
  const scheduler = new VideoScheduler({ settings: { ...DEFAULT_SETTINGS, enabled: true,
    bilibiliNativeTranslationOnly: true, targetLanguage: 'en', translationScope: 'all', videoBatchSize: 2 },
    now: () => now, nowEpochMs: () => epochNow, reset() {},
    prepared: items => prepared.push(...items), removed: ids => removed.push(...ids),
    cancelItems: (_signal, ids) => cancelled.push(...ids),
    request: (_resource, items, signal, _priority, onResult) => new Promise(resolve => calls.push({ items, signal, onResult, resolve })) });
  const source = (sourceId, text) => ({ id: JSON.stringify(['bilibili', 'video', sourceId]), sourceId,
    resourceId: 'video', platform: 'bilibili', originalText: text, mediaTimeMs: 5000, renderAtMs: 4000,
    translatable: true, style: { commands: [] } });
  const a = source('1', 'これは甲です'), b = source('2', 'これは乙です');
  const clock = { mediaTimeMs: 0, durationMs: 60_000, playbackRate: 1, paused: false,
    seeking: false, contentActive: true };
  const selection = row => ({ id: row.id, sourceId: row.sourceId, originalText: row.originalText,
    stimeMs: row.mediaTimeMs, deadlineAtEpochMs: 105_000, reasons: [] });
  const update = (revision, items, predictionEpoch = 0, ruleRevision = 1) => ({
    epoch: 0, revision, active: true, known: true, predictionEpoch, ruleRevision,
    sampledAtEpochMs: 100_000, playbackRate: 1, items });

  scheduler.snapshot('video', 'session', clock, [a, b], 0);
  scheduler.updateShadow({ epoch: 0, revision: 1, active: true, known: true,
    items: [{ id: a.id, originalText: a.originalText }] });
  assert.equal(calls.length, 0, 'legacy shadow metadata grants no strict demand');
  scheduler.updateShadow(update(2, [selection(a), selection(b)]));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].items.length, 2);
  assert.equal(calls[0].items[0].remainingMs, 5000);
  assert.equal(calls[0].items[0].sourceId, '1');
  assert.equal(calls[0].items[0].epoch, 0);
  assert.equal(calls[0].items[0].predictionEpoch, 0);
  assert.equal(calls[0].items[0].ruleRevision, 1);
  assert.ok(calls[0].items[0].configIdentity);
  assert.deepEqual(scheduler.currentNativeDemand().map(row => row.sourceId), ['1', '2']);
  removed.length = 0;

  assert.equal(scheduler.closeNativeEvent(a.id, a.originalText, 0, 0, 'suppressed'), true);
  assert.equal(scheduler.closeNativeEvent(a.id, a.originalText, 0, 0, 'duplicate'), false);
  assert.equal(calls[0].signal.aborted, false, 'other subscribers retain the shared request');
  assert.deepEqual(cancelled, [a.id]);
  assert.deepEqual(scheduler.currentNativeDemand().map(row => row.sourceId), ['2']);
  calls[0].onResult({ id: a.id, status: 'translated', text: 'late甲' });
  calls[0].onResult({ id: b.id, status: 'translated', text: '乙訳' });
  assert.deepEqual(prepared.map(row => row.id), [b.id]);
  assert.equal(prepared[0].status, 'translated');
  assert.equal(prepared[0].deadlineAtEpochMs, 105_000);
  assert.deepEqual(removed, [a.id]);
  calls[0].resolve([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1, 'strict events are not retried after a send');

  scheduler.snapshot('video', 'session', { ...clock, mediaTimeMs: 1000 }, undefined, 1);
  assert.deepEqual(scheduler.currentNativeDemand(), []);
  assert.equal(scheduler.closeNativeEvent(b.id, b.originalText, 0, 0, 'old-epoch'), false);
  scheduler.dispose();
});

test('strict scheduler rejects expiry, exact-original results and rule changes without a second send', async () => {
  let now = 0, epochNow = 100_000;
  const calls = [], prepared = [];
  const source = { id: 'a', sourceId: '1', resourceId: 'video', platform: 'bilibili',
    originalText: 'これはテストです', mediaTimeMs: 5000, renderAtMs: 4000, translatable: true,
    style: { commands: [] } };
  const scheduler = new VideoScheduler({ settings: { ...DEFAULT_SETTINGS, enabled: true,
    bilibiliNativeTranslationOnly: true, targetLanguage: 'en' }, now: () => now,
    nowEpochMs: () => epochNow, reset() {}, prepared: rows => prepared.push(...rows),
    request: (_r, items, signal, _p, onResult) => new Promise(resolve => calls.push({ items, signal, onResult, resolve })) });
  scheduler.snapshot('video', 'session', { mediaTimeMs: 0, durationMs: 60_000, playbackRate: 1,
    paused: false, seeking: false, contentActive: true }, [source], 0);
  const update = (revision, ruleRevision = 1) => ({ epoch: 0, revision, active: true, known: true,
    predictionEpoch: 0, ruleRevision, sampledAtEpochMs: 100_000, playbackRate: 1,
    items: [{ id: 'a', sourceId: '1', originalText: source.originalText, stimeMs: 5000,
      deadlineAtEpochMs: 101_000, reasons: [] }] });
  scheduler.updateShadow(update(1));
  calls[0].onResult({ id: 'a', status: 'cached', text: source.originalText });
  assert.equal(prepared.length, 0);
  epochNow = 101_001; now = 1001; scheduler.tick();
  assert.equal(calls[0].signal.aborted, true);
  calls[0].onResult({ id: 'a', status: 'translated', text: 'late' });
  assert.equal(prepared.length, 0);
  scheduler.retryFailures();
  scheduler.updateShadow(update(2, 2));
  assert.equal(calls.length, 1);
  calls[0].resolve([]);
  await new Promise(resolve => setImmediate(resolve));
  scheduler.dispose();
});

test('missed prediction closes before source arrival and cannot revive from a later selection', () => {
  const calls = [];
  const scheduler = new VideoScheduler({ settings: { ...DEFAULT_SETTINGS, enabled: true,
    bilibiliNativeTranslationOnly: true, targetLanguage: 'en' }, now: () => 0, nowEpochMs: () => 100_000,
    reset() {}, prepared() {}, request: (...args) => { calls.push(args); return Promise.resolve([]); } });
  const clock = { mediaTimeMs: 0, durationMs: 60_000, playbackRate: 1, paused: false,
    seeking: false, contentActive: true };
  scheduler.snapshot('video', 'session', clock, [], 0);
  assert.equal(scheduler.closeNativeEvent('a', 'これはテストです', 0, 0, 'missed-prediction'), true);
  const source = { id: 'a', sourceId: '1', resourceId: 'video', platform: 'bilibili',
    originalText: 'これはテストです', mediaTimeMs: 5000, renderAtMs: 4000, translatable: true,
    style: { commands: [] } };
  scheduler.updateSources([source], [], false, true);
  scheduler.updateShadow({ epoch: 0, revision: 1, active: true, known: true, predictionEpoch: 1,
    ruleRevision: 1, sampledAtEpochMs: 100_000, playbackRate: 1,
    items: [{ id: 'a', sourceId: '1', originalText: source.originalText, stimeMs: 5000,
      deadlineAtEpochMs: 105_000, reasons: [] }] });
  assert.deepEqual(scheduler.currentNativeDemand(), []);
  assert.equal(calls.length, 0);
  scheduler.dispose();
});

test('estimated expiry cancels unresolved demand but retains published result until actual native closure', async () => {
  let epochNow = 100_000;
  const calls = [], prepared = [], removed = [];
  const source = id => ({ id, sourceId: id, resourceId: 'video', platform: 'bilibili',
    originalText: `これは${id}です`, mediaTimeMs: 5000, renderAtMs: 4000, translatable: true, style: { commands: [] } });
  const rows = [source('a'), source('b')];
  const scheduler = new VideoScheduler({ settings: { ...DEFAULT_SETTINGS, enabled: true,
    bilibiliNativeTranslationOnly: true, targetLanguage: 'en', videoBatchSize: 2 },
    now: () => epochNow - 100_000, nowEpochMs: () => epochNow, reset() {},
    prepared: values => prepared.push(...values), removed: ids => removed.push(...ids),
    request: (_r, items, signal, _p, onResult) => new Promise(resolve => calls.push({ items, signal, onResult, resolve })) });
  scheduler.snapshot('video', 'session', { mediaTimeMs: 0, durationMs: 60_000, playbackRate: 1,
    paused: false, seeking: false, contentActive: true }, rows, 0);
  const update = (revision, items) => ({ epoch: 0, revision, active: true, known: true,
    predictionEpoch: 1, ruleRevision: 1, sampledAtEpochMs: epochNow, playbackRate: 1, items });
  scheduler.updateShadow(update(1, rows.map(row => ({ id: row.id, sourceId: row.id, originalText: row.originalText,
    stimeMs: row.mediaTimeMs, deadlineAtEpochMs: 101_000, reasons: [] }))));
  calls[0].onResult({ id: 'a', text: 'Prepared A', status: 'translated' });
  assert.equal(prepared.length, 1); removed.length = 0;
  epochNow = 101_001;
  scheduler.updateShadow(update(2, []));
  assert.deepEqual(scheduler.currentNativeDemand(), []);
  assert.equal(calls[0].signal.aborted, true);
  assert.deepEqual(removed, [], 'do not revoke already delivered A because forecast moved past this batch');
  calls[0].onResult({ id: 'b', text: 'Late B', status: 'translated' });
  assert.equal(prepared.length, 1);
  assert.equal(scheduler.closeNativeEvent('a', rows[0].originalText, 0, 1, 'adopted'), true);
  assert.deepEqual(removed, ['a']);
  calls[0].resolve([]); await new Promise(resolve => setImmediate(resolve)); scheduler.dispose();
});

test('strict forecast resume and rule changes preserve resource permit while retiring old results', async t => {
  let resets = 0;
  const calls = [], prepared = [], removed = [];
  const source = id => ({ id, sourceId: id, resourceId: 'video', platform: 'bilibili',
    originalText: `これは${id}です`, mediaTimeMs: 5000, renderAtMs: 4000, translatable: true, style: { commands: [] } });
  const rows = ['a', 'b', 'closed', 'new'].map(source);
  const scheduler = new VideoScheduler({ settings: { ...DEFAULT_SETTINGS, enabled: true,
    bilibiliNativeTranslationOnly: true, targetLanguage: 'en', concurrency: 1, videoBatchSize: 8 },
    now: () => 0, nowEpochMs: () => 100_000, reset() { resets++; },
    prepared: values => prepared.push(...values), removed: ids => removed.push(...ids),
    request: (_r, items, signal, _p, onResult) => new Promise(resolve => calls.push({ items, signal, onResult, resolve })) });
  t.after(() => scheduler.dispose());
  const clock = { mediaTimeMs: 0, durationMs: 60_000, playbackRate: 1,
    paused: true, seeking: false, contentActive: true };
  scheduler.snapshot('video', 'session', clock, rows, 0);
  const baseline = resets;
  const update = (revision, predictionEpoch, ruleRevision, selected, known = true) => ({
    epoch: 0, revision, active: true, known, predictionEpoch, ruleRevision,
    sampledAtEpochMs: 100_000, playbackRate: 1, items: selected.map(row => ({
      id: row.id, sourceId: row.id, originalText: row.originalText, stimeMs: 5000,
      deadlineAtEpochMs: 105_000, reasons: [] })) });
  scheduler.updateShadow(update(1, 0, 1, [], false)); // Armed while paused.
  scheduler.snapshot('video', 'session', { ...clock, paused: false }, undefined, 0);
  scheduler.updateShadow(update(2, 1, 1, rows.slice(0, 3))); // Native resume.
  assert.equal(resets, baseline, 'resume must not retire the host permit via options.reset');
  assert.equal(calls.length, 1);
  calls[0].onResult({ id: 'a', text: 'Prepared A', status: 'translated' });
  scheduler.closeNativeEvent('closed', rows[2].originalText, 0, 1, 'suppressed');
  removed.length = 0;

  scheduler.updateShadow(update(3, 2, 1, [], false)); // Pause cancels subscriptions.
  assert.equal(calls[0].signal.aborted, true);
  assert.deepEqual(removed, ['a'], 'published text is withdrawn without clearing native control');
  calls[0].onResult({ id: 'b', text: 'Stale B', status: 'translated' });
  calls[0].resolve([{ id: 'b', text: 'Stale final B', status: 'translated' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(prepared.map(row => row.id), ['a']);
  scheduler.updateShadow(update(4, 3, 2, rows)); // Resume with new rules.
  assert.equal(resets, baseline);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].items.map(row => row.id), ['new'], 'no retries or closed-event revival');
  calls[1].onResult({ id: 'new', text: 'New result', status: 'translated' });
  assert.equal(prepared.at(-1).predictionEpoch, 3);
  assert.equal(prepared.at(-1).ruleRevision, 2);
  scheduler.snapshot('video', 'session', clock, undefined, 1);
  assert.equal(resets, baseline + 1, 'a real playback epoch change still retires the session');
  assert.equal(calls[1].signal.aborted, true);
  calls[1].onResult({ id: 'new', text: 'Old epoch', status: 'translated' });
  assert.equal(prepared.length, 2);
  calls[1].resolve([]);
});
