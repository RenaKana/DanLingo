import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderPreviewEngine } from '../../src/core/render-preview.ts';

const layout = (widthPx = 600, heightPx = 60) => ({ widthPx, heightPx, fontSizePx: 20,
  lineHeightPx: 22, paddingXPx: 4, paddingYPx: 4, gapPx: 16 });
const event = (id, mediaTimeMs, text = 'short', extra = {}) => ({ id, sourceId: id, resourceId: 'part-1',
  epoch: 1, originalText: text, mediaTimeMs, bucket: Math.floor(mediaTimeMs / 1000),
  startMs: Math.floor(mediaTimeMs / 1000) * 1000, selectedAtMs: 0, selectedWallTimeMs: 0,
  leadMs: mediaTimeMs, coldStart: true, unknown: true, needsTranslation: true,
  sourceRevision: 1, ruleRevision: 1, planRevision: 1, state: 'frozen', reason: 'selected', ...extra });
const measure = text => ({ widthPx: Number(text.match(/^w(\d+)$/)?.[1] ?? 80), heightPx: 30, lines: 1 });
const engine = (options = {}) => new RenderPreviewEngine({ measure, ...options });
const sync = (renderer, events, mediaTimeMs = 0, extra = {}) => renderer.sync({ resourceId: 'part-1',
  epoch: 1, mediaTimeMs, contextValid: true, events, ...extra });
const tick = (renderer, mediaTimeMs, extra = {}) => renderer.tick({ mediaTimeMs, wallTimeMs: mediaTimeMs, ...extra });

test('same-time selection uses distinct measured lanes, and visible sampling is separate from commitment', () => {
  const renderer = engine(); renderer.setLayout(layout(), 0);
  const events = [event('a', 1000), event('b', 1000), event('c', 1000)];
  assert.deepEqual(sync(renderer, events), []);
  const frame = tick(renderer, 1000);
  assert.equal(frame.active.length, 2);
  assert.deepEqual(frame.active.map(row => row.lane), [0, 1]);
  assert.equal(frame.counts.committed, 2);
  assert.equal(frame.counts['layout-rejected'], 1);
  assert.equal(frame.counts.visibleDistinct, 0);
  renderer.sampleVisible([frame.active[0].key], 1016, 1016);
  assert.equal(renderer.report().counts.visibleDistinct, 1);
  assert.equal(renderer.report().samples.length, 1);
  assert.equal(JSON.stringify(renderer.report()).includes('short'), false);
});

test('later freeze must respect both preceding tail and an already reserved future head', () => {
  const rejected = [];
  const renderer = engine({ onEarlyReject: (row, reason) => rejected.push([row.id, reason]) });
  renderer.setLayout(layout(600, 30), 0);
  const first = event('a', 1000, 'w50'), last = event('c', 3000, 'w50');
  sync(renderer, [first, last]);
  const middle = event('b', 2000, 'w150');
  assert.deepEqual(sync(renderer, [first, middle, last]), []);
  assert.equal(renderer.report().records.find(row => row.id === 'b').state, 'unallocated');
  tick(renderer, 1000);
  tick(renderer, 2000);
  assert.equal(renderer.report().records.find(row => row.id === 'b').state, 'layout-rejected');
  assert.equal(renderer.report().records.find(row => row.id === 'c').state, 'reserved');
  assert.deepEqual(rejected, [['b', 'layout-rejected']]);
  assert.deepEqual(sync(renderer, [first, middle, last], 2000), ['b']);
  assert.deepEqual(sync(renderer, [first, middle, last], 2000), []);
});

test('original oversize and line breaks reject early; a rejected translation falls back without retiming', () => {
  const rejected = [];
  const renderer = engine({ onEarlyReject: (row, reason) => rejected.push([row.id, reason]) });
  renderer.setLayout(layout(600, 30), 0);
  assert.deepEqual(sync(renderer, [event('long', 1000, 'w1300'), event('lines', 2000, 'a\nb')]), ['long', 'lines']);
  assert.deepEqual(rejected, [['long', 'oversize'], ['lines', 'text-unsupported']]);
  assert.equal(tick(renderer, 1000).active.length, 0);

  const stored = engine({ mode: 'stored-translation', targetLanguage: 'en', resolveTranslation: row => ({
    resourceId: row.resourceId, epoch: row.epoch, id: row.id, sourceId: row.sourceId,
    originalText: row.originalText, targetLanguage: 'en', text: 'w300',
    availableAtWallMs: 0, availableAtMediaMs: 0 }) });
  stored.setLayout(layout(600, 30), 0);
  const first = event('a', 1000, 'w100'), future = event('future', 2500, 'w100');
  sync(stored, [first, future]);
  const frame = tick(stored, 1000);
  assert.equal(frame.active[0].text, 'w100');
  assert.equal(frame.active[0].sourceMode, 'original');
  const record = stored.report().records.find(row => row.id === 'a');
  assert.equal(record.translationLayoutFallback, true);
  assert.equal(record.translationReadyButRejected, true);
  assert.equal(record.latenessMs, 0);
});

test('live result identity, preview readiness, lock, submission and visible sample stay correlated without ordinary text', () => {
  const row = event('a', 1000, 'w100');
  const result = { resourceId: row.resourceId, epoch: row.epoch, id: row.id, sourceId: row.sourceId,
    originalText: row.originalText, targetLanguage: 'ja', text: 'w80', origin: 'live-local',
    runId: 'run-1', requestId: 'request-1', resultId: 'result-1', configIdentity: 'config-1',
    availableAtWallMs: 900, availableAtMediaMs: 900 };
  const renderer = engine({ mode: 'stored-translation', targetLanguage: 'ja', resolveTranslation: () => result });
  renderer.setLayout(layout(), 0); sync(renderer, [row]); renderer.noteTranslationResult(result);
  const frame = tick(renderer, 1010);
  assert.equal(frame.active[0].text, 'w80');
  renderer.sampleVisible([frame.active[0].key], 1010, 1020);
  const record = renderer.report().records[0], sample = renderer.report().samples[0];
  assert.equal(record.sourceMode, 'stored-translation');
  assert.deepEqual([record.origin, record.runId, record.requestId, record.resultId, record.configIdentity],
    ['live-local', 'run-1', 'request-1', 'result-1', 'config-1']);
  assert.deepEqual([record.previewReadyAtWallMs, record.previewReadyAtMediaMs,
    record.textLockedAtWallMs, record.textLockedAtMediaMs,
    record.renderSubmittedAtWallMs, record.renderSubmittedAtMediaMs], [900, 900, 1010, 1010, 1010, 1010]);
  assert.deepEqual([sample.origin, sample.runId, sample.requestId, sample.resultId, sample.configIdentity],
    ['live-local', 'run-1', 'request-1', 'result-1', 'config-1']);
  assert.equal('chosenText' in record, false);
  assert.equal(JSON.stringify(renderer.report()).includes('w80'), false);
  assert.equal(renderer.report(true).records[0].chosenText, 'w80');
  const late = { ...result, resultId: 'result-late', text: 'w70', availableAtWallMs: 1100 };
  renderer.noteTranslationResult(late);
  assert.equal(tick(renderer, 1100).active[0].text, 'w80');
  assert.equal(renderer.report().records[0].resultId, 'result-1');
  assert.equal(renderer.report().records[0].previewReadyAtWallMs, 900);
});

test('stored mode rejects unsupported original before due even when a translation could be ready', () => {
  const row = event('bad', 1000, 'line\nbreak');
  const renderer = engine({ mode: 'stored-translation', targetLanguage: 'ja', resolveTranslation: () => ({
    resourceId: row.resourceId, epoch: row.epoch, id: row.id, sourceId: row.sourceId,
    originalText: row.originalText, targetLanguage: 'ja', text: 'w80', availableAtWallMs: 0 }) });
  renderer.setLayout(layout(), 0);
  assert.deepEqual(sync(renderer, [row]), ['bad']);
  assert.equal(renderer.report().records[0].state, 'text-unsupported');
  assert.equal(tick(renderer, 1000).active.length, 0);
});

test('ready after t0 but before the first lock can be adopted without moving the trajectory', () => {
  const row = event('near', 1000, 'w100');
  const result = { resourceId: row.resourceId, epoch: row.epoch, id: row.id, sourceId: row.sourceId,
    originalText: row.originalText, targetLanguage: 'ja', text: 'w80',
    availableAtWallMs: 1050, availableAtMediaMs: 1050 };
  const renderer = engine({ mode: 'stored-translation', targetLanguage: 'ja', resolveTranslation: () => result });
  renderer.setLayout(layout(), 0); sync(renderer, [row]); renderer.noteTranslationResult(result);
  const frame = tick(renderer, 1100);
  assert.equal(frame.active[0].text, 'w80');
  assert.equal(frame.active[0].xPx, 590);
  const record = renderer.report().records[0];
  assert.equal(record.translationAvailableBeforeDue, false);
  assert.equal(record.previewReadyAtMediaMs, 1050);
  assert.equal(record.textLockedAtMediaMs, 1100);
  assert.equal(record.latenessMs, 100);
});

test('translation identity and availability are checked once, and later results never replace text', () => {
  let seed;
  const renderer = engine({ mode: 'stored-translation', targetLanguage: 'en', resolveTranslation: () => seed });
  renderer.setLayout(layout(), 0);
  const row = event('a', 1000, 'w100'); sync(renderer, [row]);
  seed = { resourceId: row.resourceId, epoch: row.epoch, id: row.id, sourceId: row.sourceId,
    originalText: row.originalText, targetLanguage: 'en', text: 'w80',
    availableAtWallMs: 1300, availableAtMediaMs: 1300 };
  assert.equal(tick(renderer, 1200).active[0].text, 'w100');
  renderer.noteTranslationResult(seed);
  assert.equal(tick(renderer, 1300).active[0].text, 'w100');
  assert.equal(renderer.report().counts.lateResults, 1);
  assert.equal(renderer.report().records[0].translationMissing, true);
});

test('media-time position freezes on pause and follows the same path at any playback rate', () => {
  const renderer = engine(); renderer.setLayout(layout(), 0);
  const row = event('a', 1000); sync(renderer, [row]);
  const x = tick(renderer, 1200).active[0].xPx;
  assert.equal(tick(renderer, 1300, { paused: true }).active[0].xPx, x);
  assert.equal(tick(renderer, 1400).active[0].xPx, 560);
  assert.equal(tick(renderer, 1400).active[0].xPx, 560);
});

test('first media tick applies its own 250ms grace even when planner has already marked missed', () => {
  const renderer = engine(); renderer.setLayout(layout(), 0);
  const within = event('within', 1000, 'w100', { state: 'missed' });
  sync(renderer, [within], 1200);
  const frame = tick(renderer, 1200);
  assert.equal(frame.active.length, 1);
  assert.equal(frame.active[0].xPx, 580); // Original t0, not a fresh right-edge start.
  assert.equal(renderer.report().records[0].latenessMs, 200);
  const late = event('late', 2000, 'w100', { state: 'missed' });
  sync(renderer, [within, late], 2300);
  tick(renderer, 2300);
  assert.equal(renderer.report().records.find(row => row.id === 'late').state, 'missed');
});

test('the full measured width exits naturally; 250ms does not shift its ending', () => {
  const renderer = engine(); renderer.setLayout(layout(600, 30), 0);
  sync(renderer, [event('a', 1000, 'w100')]);
  assert.equal(tick(renderer, 1250).active[0].xPx, 575);
  const endMs = renderer.report().records[0].endMs;
  assert.equal(endMs, 8020); // 600px stage + 100px text + 2px safety, at 100px/s.
  assert.equal(tick(renderer, endMs - 1).active.length, 1);
  assert.equal(tick(renderer, endMs).active.length, 0);
  assert.equal(renderer.report().records[0].state, 'exited');
});

test('rule exclusion, context failure, layout revision, hidden gap, seek and close never resurrect spent rows', () => {
  const renderer = engine(); renderer.setLayout(layout(), 0);
  const a = event('a', 1000), b = event('b', 5000);
  sync(renderer, [a, b]); tick(renderer, 1000);
  sync(renderer, [a, b], 1000, { eligibility: row => row.id === 'a' ? 'exclude' : 'unknown' });
  assert.equal(tick(renderer, 1100).active.length, 0);
  assert.equal(renderer.report().records.find(row => row.id === 'a').reason, 'rule-excluded');
  renderer.setLayout(layout(700), 1200);
  assert.equal(renderer.report().records.find(row => row.id === 'b').state, 'reserved');
  renderer.setVisible(false, 2000); renderer.setVisible(true, 5200);
  assert.equal(renderer.report().records.find(row => row.id === 'b').state, 'hidden-skipped');
  assert.equal(tick(renderer, 5200).active.length, 0);
  sync(renderer, [a, b], 5300, { contextValid: false });
  const c = event('c', 8000, 'short', { epoch: 2 });
  renderer.sync({ resourceId: 'part-1', epoch: 2, events: [c], mediaTimeMs: 6000, contextValid: true });
  tick(renderer, 8000);
  assert.equal(tick(renderer, 8100, { seeking: true }).active.length, 0);
  renderer.close(8100);
  assert.equal(renderer.tick({ mediaTimeMs: 8200, wallTimeMs: 8200 }).active.length, 0);
  assert.equal(renderer.report().counts.committed ?? 0, 0);
});
