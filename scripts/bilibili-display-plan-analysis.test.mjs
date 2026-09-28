import test from 'node:test';
import assert from 'node:assert/strict';
import { DisplayPlanSession } from '../src/diagnostics/display-plan-session.ts';
import { DEFAULT_SETTINGS } from '../src/core/config.ts';
import { analyzeBilibiliDisplayPlan } from './bilibili-display-plan-analysis.mjs';

const resourceId = 'av2:cid62131';
const source = (number, mediaTimeMs, extra = {}) => ({
  id: JSON.stringify(['bilibili', resourceId, `dmid-${number}`]), sourceId: `dmid-${number}`,
  platform: 'bilibili', resourceId, threadId: '62131', fork: 'main',
  originalText: `これは日本語の文です${number}`, mediaTimeMs, renderAtMs: mediaTimeMs,
  translatable: true, displayPlanEligible: true,
  style: { position: '1', size: '25', color: '16777215', font: '', commands: [] }, ...extra,
});
const clone = value => structuredClone(value);
const ownerKey = event => JSON.stringify([event.resourceId, event.epoch, event.id]);
const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture() {
  const settings = { ...DEFAULT_SETTINGS, enabled: false, backend: 'online', model: 'fixture',
    sourceLanguage: 'ja', targetLanguage: 'en', translationScope: 'window' };
  const session = new DisplayPlanSession(settings, { limit: 2, now: 1000 });
  const rows = [source(3, 5300), source(1, 5100), source(2, 5200), source(4, 8200)];
  const decisions = rows.map(row => ({ id: row.id, originalText: row.originalText, state: 'retain' }));
  const frame = (mediaTimeMs, wallTimeMs, extra = {}) => ({ resourceId, epoch: 1, wallTimeMs,
    clock: { mediaTimeMs, playbackRate: 1, paused: false, seeking: false, contentActive: true,
      commentsVisible: true, durationMs: 20_000, buffered: [{ startMs: 0, endMs: 20_000 }] },
    sourceRevision: 1, ruleRevision: 1, complete: true, contextValid: true, sources: rows,
    decisions, ...extra });
  session.update(frame(100, 1000));
  await flush();
  session.update(frame(5200, 3000));
  await flush();
  const report = session.report(true);
  session.stop('fixture-finished');
  return report;
}

test('independent analysis accepts actual session delta, cumulative events and outcomes without echoing text', async () => {
  const report = await fixture();
  const result = analyzeBilibiliDisplayPlan(report);
  assert.equal(result.ok, true, result.violations.join(', '));
  assert.equal(result.branches.A.selected.selected, 4);
  assert.equal(result.branches.B.selected.selected, 3);
  assert.equal(result.differences.selected, 1);
  assert.equal(result.inputFrameCount, 2);
  assert.equal(result.completeEvidence, true);
  assert.equal(JSON.stringify(result).includes('これは日本語'), false);
  assert.equal(JSON.stringify(result).includes('dmid-'), false);
});

test('selection count, source identity, bucket and freeze time are checked against reconstructed input', async () => {
  const report = await fixture();
  const changed = clone(report);
  changed.B.events[0].bucket += 1;
  assert.ok(analyzeBilibiliDisplayPlan(changed).violations.includes('B:selection-fields-mismatch'));
  const replacement = clone(report);
  replacement.B.events[1].sourceId = replacement.B.events[0].sourceId;
  assert.ok(analyzeBilibiliDisplayPlan(replacement).violations.includes('B:source-selected-twice'));
  const third = clone(report);
  third.B.events.push({ ...third.B.events[0] });
  const issues = analyzeBilibiliDisplayPlan(third).violations;
  assert.ok(issues.includes('B:event-duplicate'));
  assert.ok(issues.includes('B:bucket-density-exceeded'));
});

test('provider input must have a selected, current, eligible owner with exact original text', async () => {
  const report = await fixture();
  const event = report.B.events.find(row => row.needsTranslation && row.state === 'frozen') ?? report.B.events[0];
  const positive = clone(report);
  positive.B.providerInputLog = [{ sequence: 1, resourceId, epoch: 1,
    atMs: event.selectedWallTimeMs, originalText: event.originalText, owners: [ownerKey(event)] }];
  positive.B.simulatedProviderInputs = 1;
  assert.equal(analyzeBilibiliDisplayPlan(positive).branches.B.provider.invalidOwners, 0);
  for (const change of [
    row => { row.owners = ['missing-owner']; },
    row => { row.originalText = 'wrong text'; },
    row => { row.atMs = event.selectedWallTimeMs - 1; },
  ]) {
    const invalid = clone(positive);
    change(invalid.B.providerInputLog[0]);
    assert.ok(analyzeBilibiliDisplayPlan(invalid).violations.includes('B:provider-owner-invalid'));
  }
  const excluded = clone(positive);
  excluded.inputFrames[0].upserts.find(row => row.id === event.id).state = 'exclude';
  assert.ok(analyzeBilibiliDisplayPlan(excluded).violations.includes('B:provider-owner-invalid'));
});

test('outcome uniqueness, due grace and common A/B window parameters are independently checked', async () => {
  const report = await fixture();
  const duplicate = clone(report);
  duplicate.B.outcomes.push({ ...duplicate.B.outcomes[0] });
  assert.ok(analyzeBilibiliDisplayPlan(duplicate).violations.includes('B:outcome-duplicate'));
  const timing = clone(report);
  timing.B.events.find(row => row.state === 'due').dueMediaTimeMs += 1000;
  assert.ok(analyzeBilibiliDisplayPlan(timing).violations.includes('B:due-grace-mismatch'));
  const divergent = clone(report);
  divergent.B.parameters.lookaheadMs += 1000;
  assert.ok(analyzeBilibiliDisplayPlan(divergent).violations.includes('comparison-parameters-differ'));
});

test('A/B provider, translation and cache settings must match the isolated experiment', async () => {
  const report = await fixture();
  const result = analyzeBilibiliDisplayPlan(report);
  assert.equal(result.ok, true, result.violations.join(', '));
  const divergent = clone(report);
  divergent.B.configuration.cache.maxEntries += 1;
  assert.ok(analyzeBilibiliDisplayPlan(divergent).violations.includes('comparison-configuration-differ'));
  const missing = clone(report);
  delete missing.B.configuration;
  assert.ok(analyzeBilibiliDisplayPlan(missing).violations.includes('B:configuration-invalid'));
  const unsafe = clone(report);
  unsafe.A.configuration.provider = unsafe.B.configuration.provider = 'external';
  assert.ok(analyzeBilibiliDisplayPlan(unsafe).violations.includes('A:configuration-invalid'));
});

test('input/event history truncation blocks complete analysis while presentation truncation stays separate', async () => {
  const report = await fixture();
  const displayOnly = clone(report);
  displayOnly.B.truncation.drafts = 5;
  displayOnly.B.truncation.knownAtFreeze = 3;
  displayOnly.B.truncated = true;
  const displayResult = analyzeBilibiliDisplayPlan(displayOnly);
  assert.equal(displayResult.ok, true, displayResult.violations.join(', '));
  assert.equal(displayResult.branches.B.presentationTruncation.drafts, 5);
  const missing = clone(report);
  delete missing.inputFrames;
  assert.ok(analyzeBilibiliDisplayPlan(missing).violations.includes('input-frames-missing'));
  const inputCut = clone(report);
  inputCut.inputTruncated = true;
  assert.equal(analyzeBilibiliDisplayPlan(inputCut).completeEvidence, false);
  const eventCut = clone(report);
  eventCut.B.truncation.events = 1;
  assert.ok(analyzeBilibiliDisplayPlan(eventCut).violations.includes('B:events-truncated'));
});
