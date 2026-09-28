import test from 'node:test';
import assert from 'node:assert/strict';
import { DisplayPlanSession } from '../../src/diagnostics/display-plan-session.ts';
import { onlineSettings } from '../fixtures/online-settings.mjs';

const source = (id, originalText, mediaTimeMs) => ({ id, sourceId: `source-${id}`, platform: 'bilibili',
  resourceId: 'video:cid', threadId: 'cid', fork: 'main', originalText, mediaTimeMs,
  renderAtMs: mediaTimeMs, translatable: true, displayPlanEligible: true,
  style: { position: '1', size: '', color: '', font: '', commands: [] } });
const clockAt = (mediaTimeMs, more = {}) => ({ mediaTimeMs, playbackRate: 1, paused: false,
  seeking: false, contentActive: true, commentsVisible: true, durationMs: 120_000, ...more });
const frame = (sources, clock, more = {}) => ({ resourceId: 'video:cid', epoch: 1, clock,
  wallTimeMs: clock.mediaTimeMs, sourceRevision: 1, ruleRevision: 1, complete: true, contextValid: true,
  sources, decisions: sources.map(row => ({ id: row.id, originalText: row.originalText, state: 'unknown' })),
  ...more });
const settings = () => onlineSettings({ enabled: false, backend: 'online', displayMode: 'original',
  sourceLanguage: 'zh', targetLanguage: 'en', translationScope: 'all',
  localConcurrency: 8, concurrency: 8, batchSize: 20, videoBatchSize: 20 });
const turn = () => new Promise(resolve => setImmediate(resolve));

test('live B plans only the range, rejects unreserved entries before requesting, and sends normal outputs to preview', async t => {
  let currentClock = clockAt(45_000);
  const requests = [], ready = [];
  const reserved = new Set(['2']);
  const session = new DisplayPlanSession(settings(), { live: {
    translate: async request => {
      requests.push(request);
      for (const item of request.items) request.onResult({ id: item.id, status: 'translated',
        text: '翻訳結果', preview: { runId: 'run-1', instanceId: 'instance-1',
          configIdentity: 'config-1', requestId: request.requestId, taskId: 'task-1',
          resultId: 'result-1', originalText: item.text, kind: 'new-inference' } });
      return [];
    },
    onReady: (output, event, currentFrame) => ready.push({ output, event, currentFrame }),
  }, getCurrentClock: () => currentClock,
  getSendable: event => reserved.has(event.id), canRequest: event => reserved.has(event.id),
  beforeDispatch: snapshot => snapshot.events.filter(event => event.id === '1').map(event => event.id) });
  t.after(() => session.stop('invalidated'));
  const rows = [source('outside', '範囲外候補です', 44_900), source('1', '拒否対象です', 49_010),
    source('2', '翻訳する文章です', 49_020), source('3', '密度で選ばれない文章です', 49_030),
    source('late', '範囲外候補です', 85_100)];
  session.update(frame(rows, currentClock));
  await turn();
  const report = session.report(true);
  assert.equal(Object.hasOwn(report, 'A'), false);
  assert.deepEqual(report.B.events.map(row => row.id), ['1', '2']);
  assert.deepEqual(requests.map(request => request.items.map(item => item.id)), [['2']]);
  assert.deepEqual(session.currentDemand().map(row => row.id), ['2']);
  assert.deepEqual(session.currentDemand()[0], { id: '2', sourceId: 'source-2',
    originalText: '翻訳する文章です', mediaTimeMs: 49_020, resourceId: 'video:cid', epoch: 1 });
  assert.equal(requests[0].epoch, 1);
  assert.equal(requests[0].resourceId, 'video:cid');
  assert.equal(typeof requests[0].requestId, 'string');
  assert.equal(ready.length, 1);
  assert.equal(ready[0].event.id, '2');
  assert.equal(ready[0].currentFrame.epoch, 1);
  assert.equal(ready[0].output.preview.taskId, 'task-1');
  assert.equal(ready[0].output.preview.originalText, '翻訳する文章です');
  assert.equal(report.B.previewReadyCount, 1);
  assert.equal(report.B.previewReadyLog[0].resultId, 'result-1');
  assert.equal(report.B.previewReadyLog[0].runId, 'run-1');
  assert.equal(report.B.previewReadyLog[0].kind, 'new-inference');
  assert.equal(report.B.configuration.backend, 'local');
  assert.equal(report.B.configuration.sourceLanguage, 'auto');
  assert.equal(report.B.configuration.targetLanguage, 'ja');
  assert.equal(report.B.configuration.translationScope, 'window');
  assert.equal(report.B.configuration.prefetchSeconds, 10);
  assert.equal(report.B.configuration.localConcurrency, 2);
  assert.equal(report.B.configuration.concurrency, 2);
  assert.equal(report.B.parameters.limit, 2);
  assert.throws(() => session.configure(3), /fixed-density-two/);
  assert.equal(report.adapterPrepared, 0);
  assert.equal(Object.hasOwn(report, 'actualModelCalls'), false, 'only the background accounts real sends');
  assert.equal(JSON.stringify(session.report()).includes('翻訳する文章です'), false);
  assert.equal(JSON.stringify(session.report()).includes('翻訳結果'), false);
  currentClock = clockAt(49_020);
  assert.deepEqual(session.currentDemand(), [], 'the current clock closes the send opportunity without another frame');
});

test('live subscriptions cancel only an invalid shared occurrence; per-item ready does not await the batch', async t => {
  let currentClock = clockAt(45_000);
  const calls = [], cancelled = [], ready = [];
  const session = new DisplayPlanSession(settings(), { live: {
    translate: request => { calls.push(request); return new Promise(resolve => { request.complete = resolve; }); },
    cancelItems: (requestId, ids) => cancelled.push({ requestId, ids }),
    onReady: (output, event) => ready.push({ output, id: event.id }),
  }, getCurrentClock: () => currentClock, getSendable: () => true });
  t.after(() => session.stop('invalidated'));
  const rows = [source('1', '共有する文章です', 49_010), source('2', '共有する文章です', 49_020)];
  session.update(frame(rows, currentClock));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].items.map(item => item.id), ['1', '2']);
  const changed = frame(rows, currentClock, { ruleRevision: 2 });
  changed.decisions[0].state = 'exclude';
  session.update(changed);
  assert.deepEqual(cancelled, [{ requestId: calls[0].requestId, ids: ['1'] }]);
  assert.deepEqual(session.currentDemand().map(row => row.id), ['2']);
  calls[0].onResult({ id: '1', status: 'translated', text: '旧結果', taskId: 'shared-task' });
  calls[0].onResult({ id: '2', status: 'translated', text: '有効結果', taskId: 'shared-task', source: 'shared' });
  assert.deepEqual(ready.map(row => row.id), ['2'], 'valid item becomes ready before batch completion');
  assert.equal(ready[0].output.source, 'shared');
  calls[0].complete([]);
  await turn();
  assert.equal(session.report().B.previewReadyCount, 1);
  assert.equal(session.report().B.events[0].state, 'revoked');
  currentClock = clockAt(45_000, { paused: true });
  assert.deepEqual(session.currentDemand(), []);
});

test('an in-flight result may reach an unlocked preview after t0, but cannot start a new send there', async t => {
  let currentClock = clockAt(45_000), reserved = true;
  const calls = [], ready = [];
  const session = new DisplayPlanSession(settings(), { live: {
    translate: request => { calls.push(request); return new Promise(resolve => { request.complete = resolve; }); },
    onReady: (_output, event) => ready.push(event.id),
  }, getCurrentClock: () => currentClock, getSendable: () => reserved,
  canRequest: () => reserved });
  t.after(() => session.stop('invalidated'));
  const rows = [source('1', '遅れてもロック前なら使える文章です', 49_000)];
  session.update(frame(rows, currentClock));
  assert.equal(calls.length, 1);
  currentClock = clockAt(49_000);
  session.update(frame(rows, currentClock, { wallTimeMs: 49_000 }));
  assert.deepEqual(session.currentDemand(), []);
  calls[0].onResult({ id: '1', status: 'translated', text: '間に合った訳文' });
  assert.deepEqual(ready, ['1']);
  assert.equal(session.report().B.outcomes.find(row => row.id === '1').result, 'preview-ready');
  reserved = false;
  assert.deepEqual(session.currentDemand(), []);
  calls[0].complete([]);
  await turn();
  assert.equal(calls.length, 1);
});

test('pause, hide, seek, and stopped supply revoke requests without reviving old-epoch output', async t => {
  let currentClock = clockAt(45_000);
  const calls = [], feed = [], ready = [];
  const session = new DisplayPlanSession(settings(), { range: { startMs: 45_000, endMs: 50_000 }, live: {
    translate: request => { calls.push(request); return new Promise(resolve => { request.complete = resolve; }); },
    onReady: (_output, event) => ready.push(event.id),
  }, getCurrentClock: () => currentClock, getSendable: () => true,
  beforeDispatch: snapshot => { feed.push(snapshot.events.map(event => event.id)); return []; } });
  t.after(() => session.stop('invalidated'));
  const rows = [source('1', '時間内の文章です', 49_500)];
  session.update(frame(rows, currentClock));
  assert.equal(calls.length, 1);
  currentClock = clockAt(45_100, { paused: true });
  assert.deepEqual(session.currentDemand(), []);
  session.update(frame(rows, currentClock, { wallTimeMs: 45_100 }));
  assert.equal(calls[0].signal.aborted, true);
  calls[0].onResult({ id: '1', status: 'translated', text: '遅い訳文' });
  assert.deepEqual(ready, []);
  currentClock = clockAt(45_200, { commentsVisible: false });
  session.update(frame(rows, currentClock, { wallTimeMs: 45_200 }));
  assert.deepEqual(session.currentDemand(), []);
  currentClock = clockAt(45_250);
  session.update(frame(rows, currentClock, { contextValid: false, wallTimeMs: 45_250 }));
  assert.deepEqual(session.currentDemand(), []);
  currentClock = clockAt(45_300);
  session.update(frame(rows, currentClock, { epoch: 2, wallTimeMs: 45_300 }));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].epoch, 2);
  calls[0].complete([{ id: '1', status: 'translated', text: '古い結果' }]);
  await turn();
  assert.deepEqual(ready, []);
  session.stopSupply('main-window-ended');
  assert.equal(calls[1].signal.aborted, true);
  assert.deepEqual(session.currentDemand(), []);
  assert.equal(session.running, true, 'tail display remains active');
  assert.equal(session.view().status, 'draining');
  assert.equal(session.report().B.events.at(-1).state, 'frozen', 'the planner ledger is not revoked');
  const before = feed.length;
  currentClock = clockAt(51_000);
  session.update(frame([...rows, source('2', '尾部の新候補です', 51_500)], currentClock,
    { epoch: 2, sourceRevision: 2 }));
  assert.equal(feed.length, before + 1, 'the existing renderer feed still receives tail frames');
  assert.equal(calls.length, 2, 'tail updates cannot create a new request');
  assert.equal(session.report().B.events.at(-1).state, 'frozen');
  assert.equal(session.report().B.supplyStopped, true);
  assert.throws(() => session.resume(settings()), /supply-stopped/);
});
