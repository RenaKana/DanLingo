import test from 'node:test';
import assert from 'node:assert/strict';
import { DisplayPlanSession, displayPlanContextValid } from '../../src/diagnostics/display-plan-session.ts';
import { onlineSettings } from '../fixtures/online-settings.mjs';

const source = (id, originalText, mediaTimeMs = 5100) => ({ id, sourceId: id, platform: 'bilibili',
  resourceId: 'av123:cid456', threadId: '456', fork: 'main', originalText, mediaTimeMs, renderAtMs: mediaTimeMs,
  translatable: true, displayPlanEligible: true, style: { position: '1', size: '', color: '', font: '', commands: [] } });
const frame = (sources, overrides = {}) => ({ resourceId: 'av123:cid456', epoch: 1,
  clock: { mediaTimeMs: 0, playbackRate: 1, paused: false, seeking: false, contentActive: true, commentsVisible: true, durationMs: 100000 },
  wallTimeMs: 1000, sourceRevision: 1, ruleRevision: 1, complete: true, contextValid: true, sources,
  decisions: sources.map(row => ({ id: row.id, originalText: row.originalText, state: 'unknown' })), ...overrides });
const settings = backend => onlineSettings({ enabled: false, displayMode: 'original', backend, sourceLanguage: 'ja', targetLanguage: 'zh',
  endpoint: 'https://api.minimax.cn/v1/chat/completions', model: 'MiniMax-M3', localModelId: 'fixture',
  localPerformance: { promptMode: 'json', languageValidation: 'strict' }, batchSize: 20, videoBatchSize: 20, concurrency: 2 });

test('render-only session never creates A and early rejection suppresses only its own unsubmitted demand', async t => {
  const session = new DisplayPlanSession(settings('online'), { comparison: false,
    beforeDispatch: snapshot => snapshot.events.filter(event => event.id === '1').map(event => event.id) });
  t.after(() => session.stop('invalidated'));
  const rows = [source('1', '共有する原文です'), source('2', '共有する原文です', 5150)];
  session.update(frame(rows));
  for (let i = 0; i < 40 && session.report().B.simulatedProviderInputs === 0; i++)
    await new Promise(resolve => setTimeout(resolve, 2));
  const report = session.report(true);
  assert.equal(Object.hasOwn(report, 'A'), false);
  assert.equal(report.B.events.length, 2, 'rejection does not rewrite planning or refund density');
  assert.equal(report.B.subscriptions, 1);
  assert.equal(report.B.simulatedProviderInputs, 1);
  assert.equal(report.B.previewExcludedSubscriptions, 1);
  assert.equal(report.B.previewExcludedAfterSubmission, 0);
  assert.ok(report.B.providerInputLog.every(row => row.owners.every(key => JSON.parse(key)[2] === '2')));
  assert.equal(report.actualModelCalls, 0); assert.equal(report.adapterPrepared, 0);
});
async function settled(session) {
  for (let i = 0; i < 80; i++) {
    await new Promise(resolve => setTimeout(resolve, 2));
    const r = session.report();
    if (!r.A.engine.pendingItems && !r.B.engine.pendingItems && !r.A.scheduler.inflight && !r.B.scheduler.inflight) return;
  }
  assert.fail('memory simulation did not settle');
}

for (const backend of ['online', 'local']) test(`${backend}: display slots precede translation, drafts and unselected sources never reach provider`, async t => {
  const session = new DisplayPlanSession(settings(backend)); t.after(() => session.stop());
  const rows = [source('1', '!!!', 5010), source('2', '翻訳する文章です', 5020), source('3', '密度で選ばれない文章です', 5030),
    source('4', '遠い草稿の文章です', 9010), { ...source('5', '対象外です', 5040), displayPlanEligible: false }, source('6', '除外です', 5000)];
  const initial = frame(rows); initial.decisions.at(-1).state = 'exclude'; session.update(initial); await settled(session);
  const r = session.report(true);
  assert.deepEqual(r.B.events.map(row => row.id), ['1', '2']);
  assert.equal(r.B.events.filter(row => row.needsTranslation).length, 1);
  assert.equal(r.B.subscriptions, 1); assert.equal(r.B.simulatedProviderInputs, 1);
  assert.equal(r.A.events.length, 3); assert.equal(r.A.simulatedProviderInputs, 2);
  assert.equal(r.B.orphanInputs, 0); assert.equal(r.actualModelCalls, 0); assert.equal(r.adapterPrepared, 0);
  assert.ok(r.B.events.every(row => row.unknown));
  assert.ok(r.B.providerInputLog.every(row => row.owners.length > 0));
  assert.ok(!JSON.stringify(session.report()).includes('翻訳する文章です'));
  assert.equal(r.inputFrames[0].upserts.length, rows.length, 'input trace preserves actual first observation');
  session.update(frame(rows, { clock: { ...initial.clock, mediaTimeMs: 5100 }, wallTimeMs: 6100 }));
  assert.equal(session.report().B.outcomes.filter(row => row.state === 'due').length, 2);
});

test('shared selected events keep two due records; cancellation and seek reuse exact cache without native delivery', async t => {
  const session = new DisplayPlanSession(settings('online'), { delayMs: 25 }); t.after(() => session.stop());
  const rows = [source('1', '共有翻訳の文章です'), source('2', '共有翻訳の文章です', 5150)];
  const initial = frame(rows); session.update(initial);
  for (let i = 0; i < 40 && !session.report().B.simulatedProviderInputs; i++) await new Promise(resolve => setTimeout(resolve, 2));
  const changed = frame(rows, { ruleRevision: 2, wallTimeMs: 1100 }); changed.decisions[0].state = 'exclude';
  session.update(changed); await settled(session);
  assert.equal(session.report().B.simulatedProviderInputs, 1);
  assert.equal(session.report().B.events[0].state, 'revoked');
  assert.equal(session.report().B.outcomes[0].submittedBeforeRevocation, true);
  session.update({ ...changed, clock: { ...initial.clock, mediaTimeMs: 5200 }, wallTimeMs: 6200 });
  assert.equal(session.report().B.outcomes.find(row => row.id === '2').result, 'simulation-ready');
  session.update(frame(rows, { epoch: 2, wallTimeMs: 7000 })); await settled(session);
  assert.equal(session.report().B.simulatedProviderInputs, 1, 'same resource/text/language cache is not keyed by plan/epoch');
  session.update(frame(rows, { epoch: 2, clock: { ...initial.clock, mediaTimeMs: 5200 }, wallTimeMs: 12200 }));
  assert.equal(session.report().B.outcomes.filter(row => row.epoch === 2 && row.state === 'due').length, 2);
  assert.equal(session.report().adapterPrepared, 0);
});

test('pre-send revision cancels demand, expired/invalid contexts cannot dispatch, old epoch results cannot become ready', async t => {
  const session = new DisplayPlanSession(settings('online'), { delayMs: 30 }); t.after(() => session.stop());
  const rows = [source('1', '取り消す文章です')];
  session.update(frame(rows));
  const denied = frame(rows, { ruleRevision: 2 }); denied.decisions[0].state = 'exclude'; session.update(denied);
  await settled(session); assert.equal(session.report().B.simulatedProviderInputs, 0);
  session.update(frame(rows, { epoch: 2, contextValid: false })); await settled(session);
  assert.equal(session.report().B.simulatedProviderInputs, 0);
  session.update(frame(rows, { epoch: 3 }));
  for (let i = 0; i < 40 && !session.report().B.simulatedProviderInputs; i++) await new Promise(resolve => setTimeout(resolve, 2));
  session.update(frame([], { epoch: 4, contextValid: false })); await settled(session);
  assert.ok(session.report().B.events.every(row => row.state !== 'frozen'));
  assert.equal(session.report().B.orphanInputs, 0);
});

test('partial rule coverage is valid but contract, account scope and whole snapshot failures are not', () => {
  const summary = { contract: 'bilibili-core-ba67b466-user-rules-v1', featureEnabled: true, nativeEnabled: true,
    categories: { regexp: { status: 'partial' }, account: { status: 'unknown' } }, readEvidence: {
      storeFound: true, methodsMatch: true, callbackMatches: true, listComplete: true, switchKnown: true, accountScopeKnown: true } };
  assert.equal(displayPlanContextValid(summary), true);
  assert.equal(displayPlanContextValid({ ...summary, contract: 'other' }), false);
  assert.equal(displayPlanContextValid({ ...summary, readEvidence: { ...summary.readEvidence, accountScopeKnown: false } }), false);
});

test('stopping and resuming preserves spent buckets; the input record budget stops further work', async t => {
  const session = new DisplayPlanSession(settings('online')); t.after(() => session.stop('invalidated'));
  const rows = [source('1', '最初の文章です', 5100), source('2', '二番目の文章です', 5150)];
  session.update(frame(rows)); await settled(session);
  session.stop(); session.resume(settings('online'));
  session.update(frame([...rows, source('3', '後から来た文章です', 5120)], { sourceRevision: 2 }));
  assert.equal(session.report().B.events.length, 2, 'same epoch cannot refill revoked slots');
  assert.ok(session.report().B.events.every(row => row.state === 'revoked'));
  const start = frame([]);
  for (let n = 0; n < 1000; n++) session.update({ ...start, wallTimeMs: 2000 + n });
  const full = session.report();
  assert.equal(full.stopped, true); assert.equal(full.inputTruncated, true);
  assert.equal(full.inputFrameCount, 1000);
  assert.throws(() => session.resume(settings('online')), /budget-exhausted/);
  assert.equal(full.A.engine.activeRequests ?? 0, 0);
});

test('an incomplete source transaction retains committed selected subscriptions until a complete replacement', async t => {
  const session = new DisplayPlanSession(settings('online'), { delayMs: 20 }); t.after(() => session.stop('invalidated'));
  const rows = [source('1', '分割受信中も有効な文章です')];
  session.update(frame(rows));
  session.update(frame([], { complete: false, sourceRevision: 2 }));
  await settled(session);
  assert.equal(session.report().B.events[0].state, 'frozen');
  assert.equal(session.report().B.simulatedProviderInputs, 1);
  session.update(frame([], { complete: true, sourceRevision: 2 }));
  assert.equal(session.report().B.events[0].state, 'revoked');
});
